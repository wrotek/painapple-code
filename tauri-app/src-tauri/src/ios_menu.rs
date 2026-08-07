//! iPadOS main menu bar — Server menu + saner defaults.
//!
//! iPadOS 26 gives every app a Mac-style menu bar (earlier iPadOS shows the
//! same menus in the hold-Cmd keyboard HUD). Tauri's menu API is
//! desktop-only, so out of the box the iPad shows UIKit's auto-generated
//! defaults — which are worse than nothing for this app: the default File
//! menu's New Window (Cmd+N) and Close (Cmd+W) are matched by UIKit *before*
//! the webview's DOM sees the keystroke, silently stealing the web client's
//! clone-session (Cmd+N) and close-tab (Cmd+W) shortcuts.
//!
//! Customization goes through `UIResponder.buildMenuWithBuilder:`. UIKit
//! consults only UIApplication and its delegate when building the main menu,
//! and tao's iOS `AppDelegate` *is* a UIResponder subclass that doesn't
//! implement the method — so, exactly like `ios_quick_actions.rs`, we inject
//! it onto the live class via `class_addMethod`:
//!
//! - **`buildMenuWithBuilder:`** — forwards to `super` (UIResponder) first,
//!   then, for the main system only: removes Format (text styling we can't
//!   use) and File (shortcut thief, see above), inserts a Server menu in
//!   File's place (New Window ⇧⌘N, New Connection… ⇧⌘L, recents with ⌥⌘1-9
//!   — plain ⌘1-9 belongs to the web client's tab switching), and prepends
//!   Reload Page (⌘R) to View for launcher/dead pages where the web
//!   client's own ⌘R binding can't help.
//!
//! - **`painappleMenuAction:`** — single action selector for every item.
//!   UIKit resolves it down the responder chain to the app delegate; the
//!   IMP reads the command's `propertyList` string ("new-window",
//!   "back-to-launcher", "reload-page", "recent-{idx}") and forwards to a
//!   handler registered from `lib.rs`'s setup — the same dispatch table the
//!   macOS menu bar uses.
//!
//! Rebuilds: `rebuild()` snapshots the recents into a static and calls
//! `UIMenuSystem.mainSystem.setNeedsRebuild()`; UIKit then re-invokes
//! `buildMenuWithBuilder:`, which reads the snapshot. ObjC dispatch is fully
//! dynamic, so injecting after the system's first menu build is fine — the
//! next rebuild picks the method up.
//!
//! Key precedence note: on iOS, a Command-chord matching a menu
//! UIKeyCommand fires natively and never reaches page JS (the reverse of
//! macOS text-input keys — see `wantsPriorityOverSystemBehavior`, default
//! NO, which we keep so typing is never stolen). Our accelerators are
//! chosen to either mirror an identical in-page action (⌘R = reload) or use
//! combos the web client doesn't bind (⇧⌘N, ⇧⌘L, ⌥⌘1-9).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

use objc2::ffi::class_addMethod;
use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, Imp, ProtocolObject, Sel};
use objc2::{MainThreadMarker, msg_send, sel};
use objc2_foundation::{NSArray, NSString};
use objc2_ui_kit::{
    UICommand, UIKeyCommand, UIKeyModifierFlags, UIMenu, UIMenuBuilder, UIMenuEdit,
    UIMenuElement, UIMenuFile, UIMenuFormat, UIMenuOptions, UIMenuSystem, UIMenuView,
};
use tauri::{AppHandle, Runtime};

use crate::RecentEntry;

// Callback registered from setup() that knows the AppHandle and dispatches
// menu-action IDs (same string IDs as the macOS on_menu_event handler). The
// IMP can't capture state (raw extern "C-unwind" fn), so the indirection
// lives in this static — mirroring ios_quick_actions.
type Handler = Box<dyn Fn(&str) + Send + Sync + 'static>;

static HANDLER: OnceLock<Mutex<Option<Handler>>> = OnceLock::new();

// Snapshot of the recents list read by the buildMenuWithBuilder: IMP. The
// IMP runs on the main thread whenever UIKit rebuilds; rebuild() writes it
// (from any thread) before poking setNeedsRebuild.
static RECENTS: Mutex<Vec<RecentEntry>> = Mutex::new(Vec::new());

// AtomicBool (not OnceLock) so we can retry injection — same rationale as
// ios_quick_actions: harmless retries until the target class exists.
// (AppDelegate registers in EventLoop::new(), i.e. before setup(), so in
// practice the first attempt succeeds.)
static METHODS_INJECTED: AtomicBool = AtomicBool::new(false);

/// Register the menu-action callback. Call once during setup — overwrites
/// any previous handler.
pub fn set_handler(h: Handler) {
    *HANDLER
        .get_or_init(|| Mutex::new(None))
        .lock()
        .unwrap() = Some(h);
}

/// Update the recents snapshot and ask UIKit to rebuild the main menu.
/// Non-fatal on failure (logs and moves on) — the menu bar is sugar, not
/// the only way to reach these actions.
pub fn rebuild<R: Runtime>(app: &AppHandle<R>, recents: &[RecentEntry]) {
    *RECENTS.lock().unwrap() = recents.to_vec();
    let dispatched = app.run_on_main_thread(|| {
        if let Err(e) = inject_methods_if_needed() {
            eprintln!("ios_menu: method inject not ready yet ({e}); will retry next rebuild");
            return;
        }
        if let Some(mtm) = MainThreadMarker::new() {
            UIMenuSystem::mainSystem(mtm).setNeedsRebuild();
        }
    });
    if let Err(e) = dispatched {
        eprintln!("ios_menu: dispatch failed: {e}");
    }
}

fn inject_methods_if_needed() -> Result<(), String> {
    if METHODS_INJECTED.load(Ordering::Acquire) {
        return Ok(());
    }
    // tao registers its UIApplicationDelegate under the literal name
    // "AppDelegate" (src/platform_impl/ios/view.rs, create_delegate_class),
    // subclassing UIResponder — which is exactly what UIKit requires for
    // the delegate to be consulted during a main-menu build.
    let cls = AnyClass::get(c"AppDelegate")
        .ok_or("AppDelegate class not registered (tao iOS init hasn't run yet?)")?;
    add_method(cls, sel!(buildMenuWithBuilder:), build_menu_with_builder);
    add_method(cls, sel!(painappleMenuAction:), painapple_menu_action);
    METHODS_INJECTED.store(true, Ordering::Release);
    Ok(())
}

// Both injected methods share the shape `- (void)sel:(id)arg`, so one
// helper covers them.
//
// Idempotence is class_addMethod's own return value: it returns false only
// when the selector already exists on *that exact class* (i.e. our earlier
// injection), so false is success here. A respondsToSelector pre-check
// would be wrong — it also sees *inherited* methods, and UIResponder
// itself implements buildMenuWithBuilder:, so the check would "find" the
// superclass default and silently skip the very override we're adding.
fn add_method(
    cls: &AnyClass,
    sel: Sel,
    imp_fn: extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject),
) {
    let cls_mut: *mut AnyClass = cls as *const AnyClass as *mut AnyClass;
    // Type encoding: void return, self id, _cmd SEL, one object arg.
    let types = c"v@:@";
    let imp: Imp = unsafe {
        std::mem::transmute::<extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject), Imp>(
            imp_fn,
        )
    };
    let _already_present = unsafe { class_addMethod(cls_mut, sel, imp, types.as_ptr()) };
}

// buildMenuWithBuilder: implementation. UIKit calls this on the main thread
// whenever it (re)builds a menu system.
extern "C-unwind" fn build_menu_with_builder(
    this: *mut AnyObject,
    _cmd: Sel,
    builder: *mut AnyObject,
) {
    if this.is_null() || builder.is_null() {
        return;
    }

    // Forward to the superclass implementation first — Apple's examples
    // call super before customizing so default contributions land before
    // edits. The start class comes from the live instance (today that's
    // UIResponder, tao's AppDelegate parent) rather than a hardcoded
    // class!() so a future tao intermediate class isn't skipped. Guarded by
    // respondsToSelector in case a future SDK drops the default impl
    // (msgSendSuper to a missing method would throw).
    let superclass = unsafe { &*this }.class().superclass();
    if let Some(superclass) = superclass {
        let has_super: bool = unsafe {
            msg_send![superclass, instancesRespondToSelector: sel!(buildMenuWithBuilder:)]
        };
        if has_super {
            let _: () =
                unsafe { msg_send![super(&*this, superclass), buildMenuWithBuilder: &*builder] };
        }
    }

    let Some(mtm) = MainThreadMarker::new() else { return };

    // ProtocolObject<P> is #[repr(C)] over AnyObject (same idiom as
    // dock_menu.rs's delegate cast), so this pointer cast is layout-safe.
    let builder: &ProtocolObject<dyn UIMenuBuilder> =
        unsafe { &*(builder as *const ProtocolObject<dyn UIMenuBuilder>) };

    // Only customize the main menu bar — context-menu builds come through
    // the same selector with a different system.
    let main = UIMenuSystem::mainSystem(mtm);
    if !std::ptr::eq(
        Retained::as_ptr(&builder.system()),
        Retained::as_ptr(&main),
    ) {
        return;
    }

    customize_main_menu(builder, mtm);
}

fn customize_main_menu(builder: &ProtocolObject<dyn UIMenuBuilder>, mtm: MainThreadMarker) {
    // Format: text-styling boilerplate this app has no use for.
    builder.removeMenuForIdentifier(unsafe { UIMenuFormat });

    // File: its default New Window (Cmd+N) and Close (Cmd+W) shadow the web
    // client's clone-session and close-tab shortcuts (UIKit matches menu
    // key commands before the DOM sees the key). Server takes its slot with
    // non-conflicting accelerators; window closing on iPad is the app
    // switcher's job anyway.
    builder.removeMenuForIdentifier(unsafe { UIMenuFile });

    // Inserts (unlike removes) raise NSInternalInconsistencyException when
    // the anchor identifier is missing, and an ObjC exception unwinding
    // through this extern "C-unwind" IMP would abort — so each insert
    // checks its anchor first. Edit and View exist in every default main
    // menu build (iOS 13 → 26); the guards are belt-and-suspenders.
    if builder.menuForIdentifier(unsafe { UIMenuEdit }).is_some() {
        let server = build_server_menu(mtm);
        builder.insertSiblingMenu_beforeMenuForIdentifier(&server, unsafe { UIMenuEdit });
    }

    // Reload Page at the top of View. Same ⌘R the web client binds in-page
    // (identical effect — location.reload()), but the native item also
    // works on the launcher and on dead/foreign pages.
    if builder.menuForIdentifier(unsafe { UIMenuView }).is_some() {
        let reload =
            key_command("Reload Page", "r", UIKeyModifierFlags::Command, "reload-page", mtm);
        let reload_group = inline_group(vec![into_element_kc(reload)], mtm);
        builder.insertChildMenu_atStartOfMenuForIdentifier(&reload_group, unsafe { UIMenuView });
    }
}

fn build_server_menu(mtm: MainThreadMarker) -> Retained<UIMenu> {
    let cmd_shift = UIKeyModifierFlags::Command | UIKeyModifierFlags::Shift;

    let mut children: Vec<Retained<UIMenuElement>> = vec![
        // "New Window" spawns a real scene (matching the system item it
        // replaces); on macOS the same ID aliases to the launcher popup —
        // the divergence lives in lib.rs's handle_menu_action.
        into_element_kc(key_command("New Window", "n", cmd_shift, "new-window", mtm)),
        // Ellipsis per HIG: opens the launcher picker, doesn't act directly.
        into_element_kc(key_command(
            "New Connection…",
            "l",
            cmd_shift,
            "back-to-launcher",
            mtm,
        )),
    ];

    let recents = RECENTS.lock().unwrap().clone();
    if !recents.is_empty() {
        let mut recent_children: Vec<Retained<UIMenuElement>> =
            Vec::with_capacity(recents.len());
        for (idx, entry) in recents.iter().enumerate() {
            let label = match entry.name.as_deref().filter(|s| !s.is_empty()) {
                Some(n) => n.to_string(),
                None => entry.url.clone(),
            };
            let prop = format!("recent-{idx}");
            // ⌥⌘1-9 jumps straight to a saved server (plain ⌘1-9 belongs to
            // the web client's tab switching). Recents past 9 are click-only.
            let elem = if idx < 9 {
                into_element_kc(key_command(
                    &label,
                    &(idx + 1).to_string(),
                    UIKeyModifierFlags::Command | UIKeyModifierFlags::Alternate,
                    &prop,
                    mtm,
                ))
            } else {
                into_element_cmd(command(&label, &prop, mtm))
            };
            recent_children.push(elem);
        }
        // DisplayInline renders the recents as a separator-delimited section
        // of Server rather than a nested submenu — one tap/keystroke fewer.
        children.push(into_element_menu(inline_group(recent_children, mtm)));
    }

    UIMenu::menuWithTitle_children(
        &NSString::from_str("Server"),
        &NSArray::from_retained_slice(&children),
        mtm,
    )
}

// ── Small constructors / upcast helpers ─────────────────────────────────────

fn key_command(
    title: &str,
    input: &str,
    flags: UIKeyModifierFlags,
    property: &str,
    mtm: MainThreadMarker,
) -> Retained<UIKeyCommand> {
    let prop = NSString::from_str(property);
    // NSString → AnyObject: ObjC objects are #[repr(C)]-compatible down the
    // chain; same cast idiom as dock_menu.rs.
    let prop_any: &AnyObject = unsafe { &*(Retained::as_ptr(&prop) as *const AnyObject) };
    unsafe {
        UIKeyCommand::commandWithTitle_image_action_input_modifierFlags_propertyList(
            &NSString::from_str(title),
            None,
            sel!(painappleMenuAction:),
            &NSString::from_str(input),
            flags,
            Some(prop_any),
            mtm,
        )
    }
}

fn command(title: &str, property: &str, mtm: MainThreadMarker) -> Retained<UICommand> {
    let prop = NSString::from_str(property);
    let prop_any: &AnyObject = unsafe { &*(Retained::as_ptr(&prop) as *const AnyObject) };
    unsafe {
        UICommand::commandWithTitle_image_action_propertyList(
            &NSString::from_str(title),
            None,
            sel!(painappleMenuAction:),
            Some(prop_any),
            mtm,
        )
    }
}

fn inline_group(children: Vec<Retained<UIMenuElement>>, mtm: MainThreadMarker) -> Retained<UIMenu> {
    UIMenu::menuWithTitle_image_identifier_options_children(
        &NSString::from_str(""),
        None,
        None,
        UIMenuOptions::DisplayInline,
        &NSArray::from_retained_slice(&children),
        mtm,
    )
}

// Retained upcasts along the declared class hierarchies
// (UIKeyCommand → UICommand → UIMenuElement; UIMenu → UIMenuElement).
fn into_element_kc(kc: Retained<UIKeyCommand>) -> Retained<UIMenuElement> {
    Retained::into_super(Retained::into_super(kc))
}

fn into_element_cmd(cmd: Retained<UICommand>) -> Retained<UIMenuElement> {
    Retained::into_super(cmd)
}

fn into_element_menu(menu: Retained<UIMenu>) -> Retained<UIMenuElement> {
    Retained::into_super(menu)
}

// painappleMenuAction: implementation. UIKit resolves the selector down the
// responder chain to the app delegate and calls it on the main thread with
// the picked UICommand as sender; the propertyList string is the action ID.
extern "C-unwind" fn painapple_menu_action(
    _this: *mut AnyObject,
    _cmd: Sel,
    sender: *mut AnyObject,
) {
    if sender.is_null() {
        return;
    }
    let prop: Option<Retained<AnyObject>> = unsafe { msg_send![&*sender, propertyList] };
    let Some(prop) = prop else { return };
    let Some(action) = prop.downcast_ref::<NSString>() else { return };
    let action = action.to_string();

    if let Some(slot) = HANDLER.get() {
        if let Ok(guard) = slot.lock() {
            if let Some(h) = guard.as_ref() {
                h(&action);
            }
        }
    }
}
