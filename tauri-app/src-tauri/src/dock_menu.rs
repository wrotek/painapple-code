//! macOS Dock right-click menu — recents + "New Connection".
//!
//! There's no `NSDockTile.setMenu:` API — the Dock menu is controlled by the
//! optional `NSApplicationDelegate.applicationDockMenu:` protocol method.
//! tao's `TaoAppDelegateParent` doesn't implement it, so AppKit's default
//! ("no application menu") shows. We inject the method onto that live class
//! at runtime via `class_addMethod`, pointing it at an IMP that returns the
//! current menu from a static `AtomicPtr<NSMenu>`.
//!
//! The menu itself is built with `muda` (the same lib Tauri wraps for the
//! menu bar). `muda::MenuItem::with_id("recent-{idx}", …)` fires through
//! muda's global event channel, which `app.on_menu_event` in `lib.rs`
//! already listens to — so Dock-menu clicks route through the existing
//! `recent-{idx}` / `back-to-launcher` branches with zero new event code.
//!
//! The Dock's standard items (Options / Show All Windows / Hide / Quit) and
//! the running-windows list are appended by macOS itself, below ours.

use std::ptr;
use std::sync::atomic::{AtomicPtr, Ordering};
use std::sync::{Mutex, OnceLock};

use muda::{ContextMenu, Menu, MenuItem, PredefinedMenuItem};
use objc2::ffi::class_addMethod;
use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
use objc2::{MainThreadMarker, msg_send, sel};
use objc2_app_kit::{NSApplication, NSMenu};
use tauri::{AppHandle, Runtime};

use crate::RecentEntry;

// muda's Menu owns the underlying NSMenu (releases on Drop), so we park the
// most recent muda::Menu in this static — that keeps the raw NSMenu pointer
// stashed in CURRENT_MENU_PTR valid until the next rebuild swaps it.
//
// muda::Menu is !Send (Rc internals on macOS). The unsafe Send/Sync impls
// hold because every read/write of CURRENT happens inside the closure passed
// to AppHandle::run_on_main_thread — i.e., on the main thread.
struct DockMenuStore(Option<Menu>);
unsafe impl Send for DockMenuStore {}
unsafe impl Sync for DockMenuStore {}

static CURRENT: OnceLock<Mutex<DockMenuStore>> = OnceLock::new();

// Raw NSMenu pointer returned by the injected applicationDockMenu: IMP.
// AtomicPtr lets the IMP (called by AppKit, on the main thread) and rebuild
// (also on the main thread but a separate stack frame) communicate without
// needing a Mutex inside the IMP, which is called from Obj-C and has no
// access to the Tauri AppHandle.
static CURRENT_MENU_PTR: AtomicPtr<NSMenu> = AtomicPtr::new(ptr::null_mut());

// One-shot registration of applicationDockMenu: on the live delegate's
// class. Adding the same method twice would panic class_addMethod.
static METHOD_REGISTERED: OnceLock<()> = OnceLock::new();

/// Rebuild the Dock right-click menu from the current recents list.
///
/// Non-fatal on failure (logs and moves on) — the Dock menu is sugar, not
/// the only way to reach these actions. Errors here must not poison startup
/// or the recents-changed listener.
pub fn rebuild<R: Runtime>(app: &AppHandle<R>, recents: &[RecentEntry]) {
    let recents = recents.to_vec();
    let dispatched = app.run_on_main_thread(move || {
        if let Err(e) = install(&recents) {
            eprintln!("dock_menu: install failed: {e}");
        }
    });
    if let Err(e) = dispatched {
        eprintln!("dock_menu: dispatch failed: {e}");
    }
}

fn install(recents: &[RecentEntry]) -> Result<(), String> {
    // run_on_main_thread guarantees we're on the main thread, so this is
    // always Some — but the safe constructor keeps the contract explicit.
    let mtm = MainThreadMarker::new().ok_or("not on main thread")?;
    register_method_once(mtm)?;

    let menu = build_menu(recents).map_err(|e| format!("build: {e}"))?;

    // Store the raw pointer first so any in-flight applicationDockMenu:
    // call sees the new menu. The previous muda::Menu drops at the bottom
    // of this function — by which point the atomic already points
    // elsewhere, so no later caller can reach the freed NSMenu. If a call
    // had already loaded the old pointer before this store, the IMP's
    // retain+autorelease keeps the old menu alive for the remainder of the
    // current autorelease pool, well past the muda Drop.
    let ns_menu_ptr = menu.ns_menu() as *mut NSMenu;
    CURRENT_MENU_PTR.store(ns_menu_ptr, Ordering::Release);
    *current().lock().unwrap() = DockMenuStore(Some(menu));
    Ok(())
}

fn current() -> &'static Mutex<DockMenuStore> {
    CURRENT.get_or_init(|| Mutex::new(DockMenuStore(None)))
}

fn build_menu(recents: &[RecentEntry]) -> Result<Menu, muda::Error> {
    let menu = Menu::new();

    // Recents go first so the user's most-used servers sit closest to the
    // cursor (Dock menus pop up from the icon, so "first" = "bottom of the
    // menu" = "next to where you clicked").
    for (idx, entry) in recents.iter().enumerate() {
        let label = match entry.name.as_deref().filter(|s| !s.is_empty()) {
            Some(n) => n.to_string(),
            None => entry.url.clone(),
        };
        menu.append(&MenuItem::with_id(
            format!("recent-{idx}"),
            label,
            true,
            None,
        ))?;
    }
    if !recents.is_empty() {
        menu.append(&PredefinedMenuItem::separator())?;
    }
    // Same ID as the menu-bar "New Connection" item — the on_menu_event
    // branch in lib.rs opens the launcher popup either way.
    menu.append(&MenuItem::with_id(
        "back-to-launcher",
        "New Connection…",
        true,
        None,
    ))?;
    Ok(menu)
}

fn register_method_once(mtm: MainThreadMarker) -> Result<(), String> {
    // OnceLock::get_or_init can't return a Result, so we run the side
    // effect inside and propagate failures via an outer flag. Subsequent
    // calls return Ok immediately (the closure runs once).
    let mut err: Option<String> = None;
    METHOD_REGISTERED.get_or_init(|| {
        if let Err(e) = inject_dock_menu_method(mtm) {
            err = Some(e);
        }
    });
    match err {
        Some(e) => Err(e),
        None => Ok(()),
    }
}

fn inject_dock_menu_method(mtm: MainThreadMarker) -> Result<(), String> {
    let ns_app = NSApplication::sharedApplication(mtm);
    let delegate = ns_app.delegate().ok_or("NSApp has no delegate")?;

    // ProtocolObject<P> is #[repr(C)] over AnyObject (per objc2 source), so
    // casting the Retained's raw pointer to *const AnyObject is layout-safe.
    let any_obj: &AnyObject =
        unsafe { &*(Retained::as_ptr(&delegate) as *const AnyObject) };
    let cls: &AnyClass = any_obj.class();
    // class_addMethod mutates the class via the runtime; the cast to *mut
    // is the standard objc2 idiom for runtime-added methods.
    let cls_mut: *mut AnyClass = cls as *const AnyClass as *mut AnyClass;

    // Type encoding for `- (NSMenu *)applicationDockMenu:(NSApplication *)sender`:
    //   "@@:@"  =  return id, self id, _cmd SEL, sender id
    let types = c"@@:@";
    let sel = sel!(applicationDockMenu:);

    // Imp = unsafe extern "C-unwind" fn(); the registered function actually
    // has a typed signature, but class_addMethod takes one erased Imp slot.
    // The transmute is the trust boundary — `types` above is the runtime
    // contract that AppKit calls our IMP with.
    let imp: Imp = unsafe {
        std::mem::transmute::<
            extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject) -> *mut AnyObject,
            Imp,
        >(application_dock_menu)
    };

    let ok = unsafe { class_addMethod(cls_mut, sel, imp, types.as_ptr()) };
    if !ok.as_bool() {
        return Err("class_addMethod returned false (method already exists?)".into());
    }
    Ok(())
}

// applicationDockMenu: implementation. AppKit calls this on the main thread
// every time the user right-clicks the Dock icon. Per Cocoa memory rules,
// the returned object is autoreleased — get-accessor naming, not new/copy.
extern "C-unwind" fn application_dock_menu(
    _this: *mut AnyObject,
    _cmd: Sel,
    _sender: *mut AnyObject,
) -> *mut AnyObject {
    let ptr = CURRENT_MENU_PTR.load(Ordering::Acquire);
    if ptr.is_null() {
        // Returning nil tells AppKit "no custom items" — it still shows the
        // standard Options/Show All Windows/Hide/Quit block.
        return ptr::null_mut();
    }
    // Retain + autorelease so the NSMenu lives at least until the current
    // autorelease pool drains, even if a concurrent rebuild swaps the
    // CURRENT slot mid-display. The owning muda::Menu retains the same
    // NSMenu independently, so under steady state the retain just adds a
    // brief +1 that the next pool drain releases.
    let obj: *mut AnyObject = ptr.cast();
    unsafe {
        let _: *mut AnyObject = msg_send![obj, retain];
        let _: *mut AnyObject = msg_send![obj, autorelease];
    }
    obj
}
