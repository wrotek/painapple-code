"""
TurnQL — Lucene-inspired query language for the Shadow DB turn store.

Parses a single query string into an AST, then compiles it to a SQL WHERE clause
with positional parameters. Supports section-scoped FTS, boolean logic with
parenthesized grouping, metadata filters, numeric ranges, date filters, and
boolean flags.

Examples:
    deploy                                        # FTS across all sections + prompt
    decisions:refactor                            # FTS within 'decisions' section
    (summary:deploy OR work_done:release) AND branch:main
    file:server.py problems_solved:fix since:week cost:>0.5
    "shadow git migration"                        # Exact phrase (ILIKE)
    is:error model:opus cost:>1
    -tag:test NOT is:plan

Grammar (EBNF):
    query      ::= or_expr
    or_expr    ::= and_expr ('OR' and_expr)*
    and_expr   ::= unary ('AND'? unary)*          # implicit AND between adjacent terms
    unary      ::= 'NOT' unary | '-' atom | atom
    atom       ::= '(' or_expr ')' | QUOTED | field_expr | WORD
    field_expr ::= FIELD ':' VALUE

Operator precedence: NOT > AND (implicit) > OR
"""

import re
import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from enum import Enum
from typing import Optional

logger = logging.getLogger("painapple-code.turn-query")

# ═══════════════════════════════════════════════════════════════════════════
# Field classification
# ═══════════════════════════════════════════════════════════════════════════

# Section fields — FTS on turn_fields.search_text scoped by field_key
SECTION_FIELDS = {
    "summary", "work_done", "learnings", "decisions", "problems_solved",
    "context_for_resume", "investigation", "findings", "verification",
    "tools_used", "commands", "entities", "session_title",
    "plan_title", "plan_summary",
}

# Short aliases for common section names
FIELD_ALIASES = {
    "problems": "problems_solved",
    "context": "context_for_resume",
    "before": "until",
    "after": "since",
}

# Metadata fields — exact/prefix match on turns columns
METADATA_FIELDS = {
    "branch": "t.git_branch",
    "model": "t.model",
    "status": "t.status",
    "session": "t.session_id",
    "project": "t.project_hash",
}

# Numeric fields — comparison operators on turns columns
NUMERIC_FIELDS = {
    "cost": "t.cost",
    "duration": "t.duration_ms",
    "loops": "t.num_tool_loops",
    "tokens_in": "t.tokens_in",
    "tokens_out": "t.tokens_out",
}

# Boolean flags — is:X and has:X
BOOLEAN_FLAGS = {
    "is": {"error": "t.is_error", "plan": "t.is_plan"},
    "has": {"images": "t.has_images", "files": "t.has_files"},
}

# Date fields — temporal filters on started_at
DATE_FIELDS = {"since", "until", "after", "before"}

# Relational fields — EXISTS subqueries on child tables
RELATIONAL_FIELDS = {"tag", "file", "tool"}


# ═══════════════════════════════════════════════════════════════════════════
# Tokenizer
# ═══════════════════════════════════════════════════════════════════════════

class TokenType(Enum):
    WORD = "WORD"
    QUOTED = "QUOTED"
    LPAREN = "LPAREN"
    RPAREN = "RPAREN"
    AND = "AND"
    OR = "OR"
    NOT = "NOT"
    MINUS = "MINUS"
    EOF = "EOF"


@dataclass
class Token:
    type: TokenType
    value: str
    pos: int


def tokenize(query: str) -> list[Token]:
    """Tokenize a TurnQL query string.

    - Quoted strings: "exact phrase"
    - Parentheses: ( )
    - Keywords: AND, OR, NOT (uppercase only)
    - Negation prefix: -term
    - Everything else: WORD (including field:value as a single token)
    """
    tokens = []
    i = 0
    n = len(query)

    while i < n:
        # Skip whitespace
        if query[i].isspace():
            i += 1
            continue

        # Quoted string
        if query[i] == '"':
            j = query.find('"', i + 1)
            if j == -1:
                # Unclosed quote — take rest of string
                tokens.append(Token(TokenType.QUOTED, query[i + 1:], i))
                i = n
            else:
                tokens.append(Token(TokenType.QUOTED, query[i + 1:j], i))
                i = j + 1
            continue

        # Parentheses
        if query[i] == '(':
            tokens.append(Token(TokenType.LPAREN, '(', i))
            i += 1
            continue
        if query[i] == ')':
            tokens.append(Token(TokenType.RPAREN, ')', i))
            i += 1
            continue

        # Minus prefix (only if followed by non-space and not part of a number like -1.5)
        if query[i] == '-' and i + 1 < n and not query[i + 1].isspace() and query[i + 1] != ')':
            # Check if this could be a negative number in a range context — peek ahead
            # If the previous token was .. or a comparison op, treat as part of number
            tokens.append(Token(TokenType.MINUS, '-', i))
            i += 1
            continue

        # Word (including field:value, field:>1.5, etc.)
        j = i
        while j < n and query[j] not in ' \t\n\r()' and query[j] != '"':
            j += 1
        word = query[i:j]

        # Check for keywords (uppercase only to avoid false positives)
        if word == "AND":
            tokens.append(Token(TokenType.AND, word, i))
        elif word == "OR":
            tokens.append(Token(TokenType.OR, word, i))
        elif word == "NOT":
            tokens.append(Token(TokenType.NOT, word, i))
        else:
            tokens.append(Token(TokenType.WORD, word, i))

        i = j

    tokens.append(Token(TokenType.EOF, '', n))
    return tokens


# ═══════════════════════════════════════════════════════════════════════════
# AST nodes
# ═══════════════════════════════════════════════════════════════════════════

@dataclass
class AndNode:
    children: list = field(default_factory=list)

@dataclass
class OrNode:
    children: list = field(default_factory=list)

@dataclass
class NotNode:
    child: object = None

@dataclass
class TextSearch:
    """Bare text — FTS across all sections + user_prompt."""
    text: str = ""
    is_phrase: bool = False

@dataclass
class SectionSearch:
    """Section-scoped — FTS within a specific field_key."""
    section: str = ""
    text: str = ""
    is_phrase: bool = False

@dataclass
class PromptSearch:
    """Search only turns.user_prompt."""
    text: str = ""
    is_phrase: bool = False

@dataclass
class MetadataFilter:
    """Exact/prefix match on a turns column."""
    field: str = ""     # SQL column expression (e.g., "t.git_branch")
    value: str = ""

@dataclass
class RelationalFilter:
    """EXISTS subquery on a child table."""
    relation: str = ""  # "tag", "file", "tool"
    value: str = ""

@dataclass
class NumericFilter:
    """Numeric comparison on a turns column."""
    column: str = ""    # SQL column expression
    op: str = ">"       # ">", "<", ">=", "<=", "=", ".."
    value: float = 0.0
    value_high: float = 0.0  # Only for ".." range

@dataclass
class BooleanFlag:
    """Boolean flag like is:error, has:images."""
    column: str = ""    # SQL column expression

@dataclass
class DateFilter:
    """Date range filter on started_at."""
    direction: str = ""  # "since" or "until"
    resolved: str = ""   # ISO datetime for SQL


# ═══════════════════════════════════════════════════════════════════════════
# Parser — recursive descent
# ═══════════════════════════════════════════════════════════════════════════

class QueryParseError(Exception):
    pass


class TurnQueryParser:
    """Recursive descent parser for TurnQL queries."""

    def __init__(self, tokens: list[Token]):
        self.tokens = tokens
        self.pos = 0
        self.warnings: list[str] = []

    def parse(self):
        """Parse tokens into an AST node."""
        if self._peek().type == TokenType.EOF:
            return None  # Empty query
        node = self._or_expr()
        if self._peek().type != TokenType.EOF:
            self.warnings.append(f"Unexpected token at position {self._peek().pos}: '{self._peek().value}'")
        return node

    def _peek(self) -> Token:
        return self.tokens[self.pos] if self.pos < len(self.tokens) else Token(TokenType.EOF, '', -1)

    def _advance(self) -> Token:
        tok = self.tokens[self.pos]
        self.pos += 1
        return tok

    def _match(self, *types: TokenType) -> Optional[Token]:
        if self._peek().type in types:
            return self._advance()
        return None

    def _can_start_atom(self) -> bool:
        """Check if current token can start an atom (for implicit AND)."""
        return self._peek().type in (
            TokenType.WORD, TokenType.QUOTED, TokenType.LPAREN,
            TokenType.NOT, TokenType.MINUS,
        )

    def _or_expr(self):
        """or_expr ::= and_expr ('OR' and_expr)*"""
        left = self._and_expr()
        children = [left]
        while self._match(TokenType.OR):
            children.append(self._and_expr())
        return children[0] if len(children) == 1 else OrNode(children=children)

    def _and_expr(self):
        """and_expr ::= unary (('AND' | implicit) unary)*"""
        left = self._unary()
        children = [left]
        while True:
            if self._match(TokenType.AND):
                children.append(self._unary())
            elif self._can_start_atom():
                children.append(self._unary())
            else:
                break
        return children[0] if len(children) == 1 else AndNode(children=children)

    def _unary(self):
        """unary ::= 'NOT' unary | '-' atom | atom"""
        if self._match(TokenType.NOT):
            return NotNode(child=self._unary())
        if self._match(TokenType.MINUS):
            return NotNode(child=self._atom())
        return self._atom()

    def _atom(self):
        """atom ::= '(' or_expr ')' | QUOTED | WORD (with field dispatch)"""
        # Parenthesized group
        if self._match(TokenType.LPAREN):
            node = self._or_expr()
            if not self._match(TokenType.RPAREN):
                self.warnings.append("Unclosed parenthesis")
            return node

        # Quoted phrase
        tok = self._match(TokenType.QUOTED)
        if tok:
            return TextSearch(text=tok.value, is_phrase=True)

        # Word or field:value
        tok = self._match(TokenType.WORD)
        if tok:
            return self._parse_word(tok)

        # Fallback — shouldn't happen but be safe
        tok = self._advance()
        self.warnings.append(f"Unexpected '{tok.value}' at position {tok.pos}")
        return TextSearch(text=tok.value)

    def _parse_word(self, tok: Token):
        """Dispatch a WORD token — could be bare text or field:value."""
        word = tok.value

        # No colon → bare text search
        if ':' not in word:
            return TextSearch(text=word)

        field_name, _, raw_value = word.partition(':')
        field_name = field_name.lower()

        # Resolve aliases
        field_name = FIELD_ALIASES.get(field_name, field_name)

        # Empty value after colon → check if next token is a quoted phrase
        # This handles field:"quoted phrase" where tokenizer splits on the quote
        if not raw_value:
            next_tok = self._match(TokenType.QUOTED)
            if next_tok:
                raw_value = next_tok.value
                # For section/prompt scopes, mark as phrase for ILIKE matching
                if field_name in SECTION_FIELDS:
                    return SectionSearch(section=field_name, text=raw_value, is_phrase=True)
                if field_name == "prompt":
                    return PromptSearch(text=raw_value, is_phrase=True)
                # For other fields, re-run dispatch with the quoted value
            else:
                self.warnings.append(f"Empty value for '{field_name}:', searching as text")
                return TextSearch(text=word)

        # --- Boolean flags: is:error, has:images ---
        if field_name in BOOLEAN_FLAGS:
            flag_map = BOOLEAN_FLAGS[field_name]
            flag_key = raw_value.lower()
            if flag_key in flag_map:
                return BooleanFlag(column=flag_map[flag_key])
            self.warnings.append(f"Unknown flag '{field_name}:{raw_value}'")
            return TextSearch(text=raw_value)

        # --- Date filters: since:7d, until:2026-01-15 ---
        if field_name in DATE_FIELDS:
            field_name = FIELD_ALIASES.get(field_name, field_name)  # after→since, before→until
            resolved = _resolve_date(raw_value)
            if resolved:
                return DateFilter(direction=field_name, resolved=resolved)
            self.warnings.append(f"Could not parse date '{raw_value}'")
            return TextSearch(text=raw_value)

        # --- Numeric fields: cost:>1, duration:>60000, cost:0.5..2 ---
        if field_name in NUMERIC_FIELDS:
            column = NUMERIC_FIELDS[field_name]
            node = _parse_numeric(column, raw_value)
            if node:
                return node
            self.warnings.append(f"Invalid numeric in '{word}', searching as text")
            return TextSearch(text=raw_value)

        # --- Relational: tag:X, file:X, tool:X ---
        if field_name in RELATIONAL_FIELDS:
            return RelationalFilter(relation=field_name, value=raw_value)

        # --- Metadata: branch:main, model:opus, status:completed ---
        if field_name in METADATA_FIELDS:
            return MetadataFilter(field=METADATA_FIELDS[field_name], value=raw_value)

        # --- Section-scoped FTS: summary:deploy, decisions:refactor ---
        if field_name in SECTION_FIELDS:
            is_phrase = False
            text = raw_value
            # Support section:"quoted phrase" — value already has quotes stripped
            # if the tokenizer saw it as part of the word
            if text.startswith('"') and text.endswith('"'):
                text = text[1:-1]
                is_phrase = True
            return SectionSearch(section=field_name, text=text, is_phrase=is_phrase)

        # --- prompt:X — special, searches user_prompt only ---
        if field_name == "prompt":
            return PromptSearch(text=raw_value)

        # --- Unknown field → treat as bare text, warn ---
        self.warnings.append(f"Unknown field '{field_name}', searching all text for '{raw_value}'")
        return TextSearch(text=raw_value)


# ═══════════════════════════════════════════════════════════════════════════
# Helpers
# ═══════════════════════════════════════════════════════════════════════════

def _resolve_date(value: str) -> Optional[str]:
    """Resolve a date value to an ISO timestamp string."""
    now = datetime.now(timezone.utc)

    # Relative: 7d, 30d
    m = re.match(r'^(\d+)d$', value)
    if m:
        dt = now - timedelta(days=int(m.group(1)))
        return dt.isoformat()

    # Named shortcuts
    named = {
        "today": now.replace(hour=0, minute=0, second=0, microsecond=0),
        "yesterday": (now - timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0),
        "week": now - timedelta(weeks=1),
        "month": now - timedelta(days=30),
    }
    if value.lower() in named:
        return named[value.lower()].isoformat()

    # ISO date: 2026-01-15
    if re.match(r'^\d{4}-\d{2}-\d{2}$', value):
        return f"{value}T00:00:00+00:00"

    # Full ISO datetime
    if re.match(r'^\d{4}-\d{2}-\d{2}T', value):
        return value

    return None


def _parse_numeric(column: str, value: str) -> Optional[NumericFilter]:
    """Parse a numeric filter value like >1, <0.5, >=10, 0.5..2."""
    # Range: 0.5..2
    m = re.match(r'^([\d.]+)\.\.([\d.]+)$', value)
    if m:
        try:
            return NumericFilter(column=column, op="..",
                                 value=float(m.group(1)), value_high=float(m.group(2)))
        except ValueError:
            return None

    # Comparison: >=, <=, >, <, =
    m = re.match(r'^(>=|<=|>|<|=)([\d.]+)$', value)
    if m:
        try:
            return NumericFilter(column=column, op=m.group(1), value=float(m.group(2)))
        except ValueError:
            return None

    # Bare number: exact match
    try:
        return NumericFilter(column=column, op="=", value=float(value))
    except ValueError:
        return None


# ═══════════════════════════════════════════════════════════════════════════
# SQL Compiler
# ═══════════════════════════════════════════════════════════════════════════

@dataclass
class CompiledQuery:
    """Result of compiling a TurnQL AST to SQL."""
    where_clause: str
    params: list
    fts_used: bool
    warnings: list[str]
    description: str  # Human-readable description of what was parsed


def compile_turn_query(ast, fts_available: bool = False) -> CompiledQuery:
    """Compile a TurnQL AST into a SQL WHERE clause.

    Args:
        ast: Root AST node from TurnQueryParser.parse()
        fts_available: Whether DuckDB FTS indexes are available

    Returns:
        CompiledQuery with where_clause referencing 't' alias for turns table.
    """
    if ast is None:
        return CompiledQuery(where_clause="1=1", params=[], fts_used=False,
                             warnings=[], description="(all turns)")

    ctx = _CompileCtx(fts_available=fts_available)
    sql, params = _compile_node(ast, ctx)

    return CompiledQuery(
        where_clause=sql,
        params=params,
        fts_used=ctx.fts_used,
        warnings=ctx.warnings,
        description=_describe_node(ast),
    )


@dataclass
class _CompileCtx:
    fts_available: bool = False
    fts_used: bool = False
    warnings: list[str] = field(default_factory=list)


def _compile_node(node, ctx: _CompileCtx) -> tuple[str, list]:
    """Recursively compile an AST node to (sql_fragment, params)."""

    if isinstance(node, AndNode):
        parts = [_compile_node(c, ctx) for c in node.children]
        sql = " AND ".join(f"({p[0]})" for p in parts)
        params = [p for part in parts for p in part[1]]
        return sql, params

    if isinstance(node, OrNode):
        parts = [_compile_node(c, ctx) for c in node.children]
        sql = " OR ".join(f"({p[0]})" for p in parts)
        params = [p for part in parts for p in part[1]]
        return sql, params

    if isinstance(node, NotNode):
        inner_sql, inner_params = _compile_node(node.child, ctx)
        return f"NOT ({inner_sql})", inner_params

    if isinstance(node, TextSearch):
        return _compile_text_search(node.text, node.is_phrase, ctx)

    if isinstance(node, SectionSearch):
        return _compile_section_search(node.section, node.text, node.is_phrase, ctx)

    if isinstance(node, PromptSearch):
        return _compile_prompt_search(node.text, node.is_phrase, ctx)

    if isinstance(node, MetadataFilter):
        return _compile_metadata(node, ctx)

    if isinstance(node, RelationalFilter):
        return _compile_relational(node, ctx)

    if isinstance(node, NumericFilter):
        return _compile_numeric(node, ctx)

    if isinstance(node, BooleanFlag):
        return f"{node.column} = true", []

    if isinstance(node, DateFilter):
        if node.direction == "since":
            return "t.started_at >= ?::TIMESTAMPTZ", [node.resolved]
        else:
            return "t.started_at <= ?::TIMESTAMPTZ", [node.resolved]

    ctx.warnings.append(f"Unknown node type: {type(node).__name__}")
    return "1=1", []


def _compile_text_search(text: str, is_phrase: bool, ctx: _CompileCtx) -> tuple[str, list]:
    """Compile a bare text search (all sections + user_prompt)."""
    if not is_phrase and ctx.fts_available:
        ctx.fts_used = True
        return (
            "(fts_main_turns.match_bm25(t.id, ?) IS NOT NULL "
            "OR EXISTS (SELECT 1 FROM turn_fields f WHERE f.turn_id = t.id "
            "AND fts_main_turn_fields.match_bm25(f.id, ?) IS NOT NULL))"
        ), [text, text]

    # Phrases or FTS unavailable → ILIKE
    pattern = f"%{text}%"
    return (
        "(t.user_prompt ILIKE ? OR EXISTS "
        "(SELECT 1 FROM turn_fields f WHERE f.turn_id = t.id AND f.search_text ILIKE ?))"
    ), [pattern, pattern]


def _compile_section_search(section: str, text: str, is_phrase: bool,
                             ctx: _CompileCtx) -> tuple[str, list]:
    """Compile a section-scoped text search."""
    if not is_phrase and ctx.fts_available:
        ctx.fts_used = True
        return (
            "EXISTS (SELECT 1 FROM turn_fields f WHERE f.turn_id = t.id "
            "AND f.field_key = ? "
            "AND fts_main_turn_fields.match_bm25(f.id, ?) IS NOT NULL)"
        ), [section, text]

    pattern = f"%{text}%"
    return (
        "EXISTS (SELECT 1 FROM turn_fields f WHERE f.turn_id = t.id "
        "AND f.field_key = ? AND f.search_text ILIKE ?)"
    ), [section, pattern]


def _compile_prompt_search(text: str, is_phrase: bool, ctx: _CompileCtx) -> tuple[str, list]:
    """Compile a user_prompt-only search."""
    if not is_phrase and ctx.fts_available:
        ctx.fts_used = True
        return "fts_main_turns.match_bm25(t.id, ?) IS NOT NULL", [text]

    return "t.user_prompt ILIKE ?", [f"%{text}%"]


def _compile_metadata(node: MetadataFilter, ctx: _CompileCtx) -> tuple[str, list]:
    """Compile a metadata filter."""
    col = node.field

    # model: always ILIKE for partial matching (opus, sonnet, haiku)
    if col == "t.model":
        return f"{col} ILIKE ?", [f"%{node.value}%"]

    # session/project: prefix match
    if col in ("t.session_id", "t.project_hash"):
        return f"{col} LIKE ?", [f"{node.value}%"]

    # branch, status: exact match (support * glob)
    if '*' in node.value:
        pattern = node.value.replace('*', '%')
        return f"{col} ILIKE ?", [pattern]

    return f"{col} = ?", [node.value]


def _compile_relational(node: RelationalFilter, ctx: _CompileCtx) -> tuple[str, list]:
    """Compile a relational filter (tag, file, tool)."""
    if node.relation == "tag":
        return (
            "EXISTS (SELECT 1 FROM tags tg WHERE tg.turn_id = t.id AND tg.tag = ?)"
        ), [node.value.lower()]

    if node.relation == "file":
        # Auto-wildcard: server.py → %server.py%, *.css → %.css
        value = node.value
        if '*' in value:
            pattern = value.replace('*', '%')
        elif '/' in value:
            pattern = f"%{value}"  # path fragment
        else:
            pattern = f"%{value}%"  # bare filename
        return (
            "EXISTS (SELECT 1 FROM turn_files tf WHERE tf.turn_id = t.id "
            "AND tf.file_path ILIKE ?)"
        ), [pattern]

    if node.relation == "tool":
        return (
            "EXISTS (SELECT 1 FROM turn_tools tt WHERE tt.turn_id = t.id "
            "AND tt.tool_name = ?)"
        ), [node.value]

    return "1=1", []


def _compile_numeric(node: NumericFilter, ctx: _CompileCtx) -> tuple[str, list]:
    """Compile a numeric comparison."""
    col = node.column
    if node.op == "..":
        return f"{col} BETWEEN ? AND ?", [node.value, node.value_high]
    return f"{col} {node.op} ?", [node.value]


# ═══════════════════════════════════════════════════════════════════════════
# Human-readable description
# ═══════════════════════════════════════════════════════════════════════════

def _describe_node(node) -> str:
    """Generate a human-readable description of an AST node."""
    if node is None:
        return "(all)"

    if isinstance(node, AndNode):
        parts = [_describe_node(c) for c in node.children]
        return " AND ".join(parts)

    if isinstance(node, OrNode):
        parts = [_describe_node(c) for c in node.children]
        return "(" + " OR ".join(parts) + ")"

    if isinstance(node, NotNode):
        return f"NOT {_describe_node(node.child)}"

    if isinstance(node, TextSearch):
        q = f'"{node.text}"' if node.is_phrase else node.text
        return f"text={q}"

    if isinstance(node, SectionSearch):
        q = f'"{node.text}"' if node.is_phrase else node.text
        return f"{node.section}:{q}"

    if isinstance(node, PromptSearch):
        return f"prompt:{node.text}"

    if isinstance(node, MetadataFilter):
        name = node.field.split('.')[-1]  # t.git_branch → git_branch
        return f"{name}={node.value}"

    if isinstance(node, RelationalFilter):
        return f"{node.relation}={node.value}"

    if isinstance(node, NumericFilter):
        name = node.column.split('.')[-1]
        if node.op == "..":
            return f"{name}:{node.value}..{node.value_high}"
        return f"{name}{node.op}{node.value}"

    if isinstance(node, BooleanFlag):
        name = node.column.split('.')[-1]
        return name

    if isinstance(node, DateFilter):
        return f"{node.direction}:{node.resolved[:10]}"

    return str(node)


# ═══════════════════════════════════════════════════════════════════════════
# Public API
# ═══════════════════════════════════════════════════════════════════════════

def parse_turn_query(query: str):
    """Parse a TurnQL query string into an AST.

    Returns (ast_node, warnings). ast_node is None for empty queries.
    Never raises — returns warnings for invalid syntax.
    """
    try:
        tokens = tokenize(query.strip())
        parser = TurnQueryParser(tokens)
        ast = parser.parse()
        return ast, parser.warnings
    except Exception as e:
        logger.warning(f"TurnQL parse error: {e}")
        # Fallback: treat entire query as bare text search
        return TextSearch(text=query.strip()), [f"Parse error, searching as text: {e}"]
