"""Shared FastAPI dependencies for route modules.

Pulls repeated "look up session, 404 if missing" boilerplate out of every
endpoint that takes a {session_id} path parameter.
"""

from fastapi import HTTPException

from painapple_code import paths
from painapple_code.session_store import SessionStore


def get_session_store(session_id: str) -> SessionStore:
    """Resolve a {session_id} path param to its SessionStore, or 404."""
    store, _ = SessionStore._find_session(session_id)
    if store is None:
        raise HTTPException(status_code=404, detail="Session not found")
    return store


def effective_default_provider(app):
    """The provider NEW sessions get: the --default-provider server flag wins,
    then the `default_provider` global-config key, then the registry default.
    Mirrors the resolution ws_chat.py uses when creating a session."""
    from painapple_code.providers import get_provider
    bridge = getattr(app.state, "bridge", None)
    name = (getattr(bridge, "default_provider", None)
            or paths.load_global_config().get("default_provider"))
    return get_provider(name)


def provider_enabled_map(app) -> dict:
    """Which engines the picker offers: ``{provider_name: bool}``.

    Per-engine resolution: `providers_enabled` config override if present,
    else the provider's self-described `default_enabled`. The effective
    default engine is always on — new sessions land on it, so hiding it
    would strand the picker. This gates only UI listing; explicit selection
    (``?provider=``, PUT) and already-bound sessions ignore it.
    """
    from painapple_code.providers import all_providers
    overrides = paths.load_global_config().get("providers_enabled") or {}
    default_name = effective_default_provider(app).name
    return {
        p.name: p.name == default_name or bool(overrides.get(p.name, p.default_enabled))
        for p in all_providers()
    }


def bind_permission_level(stored_level, provider):
    """Permission level to stamp when a session BINDS to `provider` (create
    with an explicit engine, or an in-place switch) — or None to leave the
    meta alone.

    The effective level (session's stored one, else the app-wide default)
    survives when the new engine speaks it. A cross-vocabulary value (e.g.
    Claude's ``dontAsk`` landing on a Codex session) is re-anchored to the
    engine's own default: launch would otherwise apply a silent back-compat
    mapping the UI can't label, leaving the permission chip showing a mode
    the engine doesn't have. Meta, UI, and launch must agree at bind time.
    """
    from painapple_code.providers import DEFAULT_PROVIDER, get_provider
    if provider is None:
        return None
    effective = stored_level
    if effective is None:
        config = paths.load_global_config()
        effective = (config.get("default_permission_level")
                     or get_provider(DEFAULT_PROVIDER).default_permission_mode())
    vocab = {m["value"] for m in provider.permission_modes() if m.get("value")}
    if effective in vocab:
        return None
    return provider.default_permission_mode()


def preferred_model_survives(stored_model, provider) -> bool:
    """Whether a session's stored ``preferred_model`` still means something
    after binding to `provider` (in-place engine switch) — False = clear it.

    A model pick only makes sense to the engine whose catalog offered it: a
    Claude id pinned on a session switching to Codex would be silently
    dropped at launch (Codex forwards only its own ids) while the model chip
    keeps labeling the stale pick — and the reverse would hand Claude an id
    its API rejects. Clearing resets the session to the new engine's own
    default. An engine with an EMPTY catalog (the app doesn't manage its
    models) keeps the stored value — its launch path decides what to
    forward. Prefix match, same as the UI: engine-reported ids carry date
    suffixes ("claude-opus-4-6-20260105" is catalog id "claude-opus-4-6").

    Membership is checked against `enabled_models()` — a model the user hid
    in Settings isn't offered anywhere, so it can't survive as a default
    either (the chip would label it "Default" while launch passed the hidden
    id). The emptiness escape stays on the RAW catalog: all-models-hidden
    means "offer nothing" (clear), not "unknown vocabulary" (keep).
    """
    if provider is None or not stored_model:
        return True
    if not any(m.get("id") for m in provider.models()):
        return True
    enabled_ids = [m.get("id") for m in provider.enabled_models() if m.get("id")]
    return any(stored_model.startswith(mid) for mid in enabled_ids)


def provider_is_locked(meta: dict) -> bool:
    """A session's engine is frozen once it has run a turn — the conversation
    lives in that engine's on-disk format (its provider_session_id means
    nothing to another engine), so the provider is only switchable while the
    session is still empty (no turns, no upstream session id)."""
    return bool(meta.get("message_count", 0)) or bool(meta.get("provider_session_id"))
