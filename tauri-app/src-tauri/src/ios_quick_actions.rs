//! iPad/iPhone Dock + Home Screen Quick Actions — recents as
//! `UIApplicationShortcutItem`s.
//!
//! On iPadOS, right-clicking (or long-pressing) the app icon in the Dock or
//! Home Screen shows the Quick Actions menu above the system items (Show
//! All Windows / Hide / Quit). This is the iOS-side analogue of the macOS
//! Dock right-click menu.
//!
//! Two pieces of plumbing:
//!
//! 1. **The items.** Rebuilt on `recents-changed` (and once at setup with an
//!    empty list as a placeholder). `UIApplication.shared.shortcutItems` is
//!    a get/set property — we mirror the recents Vec into it on the main
//!    thread.
//!
//! 2. **The click handler.** When the user picks a shortcut iOS calls
//!    `windowScene:performActionForShortcutItem:completionHandler:` on the
//!    scene delegate. tao's `TaoSceneDelegate` doesn't implement it (the
//!    behaviour would otherwise be "ignored"), so we inject the method
//!    onto its class via `class_addMethod`. The IMP parses `recent-{idx}`
//!    out of the shortcut's type and forwards to a handler registered
//!    from `lib.rs`'s setup — which is the same `navigate_focused_to_recent`
//!    that the macOS menu/Dock paths use.
//!
//! Limitations:
//!
//! - **Cold launch** isn't wired: if iOS starts the app *because* of a
//!   shortcut tap, the shortcut item arrives in
//!   `scene:willConnectToSession:options:` (not the perform-action path).
//!   We don't read that yet, so a cold-launched user lands on the launcher
//!   instead of jumping straight to the server. Warm taps (app already
//!   running) work — that's the common case.
//!
//! - The completion-handler block passed by iOS is intentionally not
//!   invoked. iOS logs a warning but otherwise treats the action as
//!   completed; invoking it requires `block2` and adds dep weight for no
//!   visible-to-user gain (navigation already kicks off async).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

use objc2::ffi::class_addMethod;
use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
use objc2::{MainThreadMarker, msg_send, sel};
use objc2_foundation::{NSArray, NSString};
use objc2_ui_kit::{UIApplication, UIApplicationShortcutItem};
use tauri::{AppHandle, Runtime};

use crate::RecentEntry;

// Callback registered from setup() that knows the AppHandle and dispatches
// to navigate_focused_to_recent. The IMP can't capture state (it's a raw
// extern "C-unwind" fn), so the indirection lives in this static.
type Handler = Box<dyn Fn(usize) + Send + Sync + 'static>;

static HANDLER: OnceLock<Mutex<Option<Handler>>> = OnceLock::new();

// AtomicBool (not OnceLock) so we can retry injection: tao's TaoSceneDelegate
// class isn't registered until the first scene connects, which can happen
// after setup() runs. We retry on every rebuild until the class exists and
// class_addMethod succeeds.
static METHOD_INJECTED: AtomicBool = AtomicBool::new(false);

/// Register the click callback. Call once during setup — overwrites any
/// previous handler.
pub fn set_handler(h: Handler) {
    *HANDLER
        .get_or_init(|| Mutex::new(None))
        .lock()
        .unwrap() = Some(h);
}

/// Rebuild the Quick Actions list from the current recents. Non-fatal on
/// failure (logs and moves on) — Quick Actions are sugar, not the only way
/// to reach the launcher.
pub fn rebuild<R: Runtime>(app: &AppHandle<R>, recents: &[RecentEntry]) {
    let recents = recents.to_vec();
    let dispatched = app.run_on_main_thread(move || {
        if let Err(e) = install(&recents) {
            eprintln!("ios_quick_actions: install failed: {e}");
        }
    });
    if let Err(e) = dispatched {
        eprintln!("ios_quick_actions: dispatch failed: {e}");
    }
}

fn install(recents: &[RecentEntry]) -> Result<(), String> {
    let mtm = MainThreadMarker::new().ok_or("not on main thread")?;

    // Set shortcut items first: it doesn't depend on the scene-delegate
    // method being injected, so even if the inject fails this rebuild the
    // items still appear in the Dock. The next rebuild will retry the
    // inject, by which point a scene has typically connected and tao has
    // registered TaoSceneDelegate.
    let mut items: Vec<Retained<UIApplicationShortcutItem>> = Vec::with_capacity(recents.len());
    for (idx, entry) in recents.iter().enumerate() {
        let label = match entry.name.as_deref().filter(|s| !s.is_empty()) {
            Some(n) => n.to_string(),
            None => entry.url.clone(),
        };
        let item_type = NSString::from_str(&format!("recent-{idx}"));
        let title = NSString::from_str(&label);
        let allocated = mtm.alloc::<UIApplicationShortcutItem>();
        let item = UIApplicationShortcutItem::initWithType_localizedTitle(
            allocated, &item_type, &title,
        );
        items.push(item);
    }
    let array = NSArray::from_retained_slice(&items);
    UIApplication::sharedApplication(mtm).setShortcutItems(Some(&array));

    // Retry inject until it sticks. Idempotent via the AtomicBool guard.
    if let Err(e) = inject_handler_if_needed() {
        eprintln!("ios_quick_actions: scene-delegate inject not ready yet ({e}); will retry next rebuild");
    }
    Ok(())
}

fn inject_handler_if_needed() -> Result<(), String> {
    if METHOD_INJECTED.load(Ordering::Acquire) {
        return Ok(());
    }
    inject_scene_delegate_method()?;
    METHOD_INJECTED.store(true, Ordering::Release);
    Ok(())
}

fn inject_scene_delegate_method() -> Result<(), String> {
    // Inject the perform-action method on tao's scene delegate class. tao
    // registers it under this name in scene.rs via `#[name = "TaoSceneDelegate"]`.
    let cls = AnyClass::get(c"TaoSceneDelegate")
        .ok_or("TaoSceneDelegate class not registered (tao iOS init hasn't run yet?)")?;
    let cls_mut: *mut AnyClass = cls as *const AnyClass as *mut AnyClass;

    let sel = sel!(windowScene:performActionForShortcutItem:completionHandler:);
    // Type encoding: void return, then self id, _cmd SEL, windowScene id,
    // shortcutItem id, completionHandler block (also an id) — three colons
    // in the selector → three @ args after `:`.
    let types = c"v@:@@@";
    let imp: Imp = unsafe {
        std::mem::transmute::<
            extern "C-unwind" fn(
                *mut AnyObject,
                Sel,
                *mut AnyObject,
                *mut AnyObject,
                *mut AnyObject,
            ),
            Imp,
        >(window_scene_perform_action)
    };
    let ok = unsafe { class_addMethod(cls_mut, sel, imp, types.as_ptr()) };
    if !ok.as_bool() {
        return Err("class_addMethod returned false (already present?)".into());
    }
    Ok(())
}

// windowScene:performActionForShortcutItem:completionHandler: implementation.
// iOS calls this on the main thread when the user picks a Quick Action while
// the app is foreground/background. The completion handler block is left
// uninvoked — see the module doc-comment.
extern "C-unwind" fn window_scene_perform_action(
    _this: *mut AnyObject,
    _cmd: Sel,
    _window_scene: *mut AnyObject,
    shortcut_item: *mut AnyObject,
    _completion_handler: *mut AnyObject,
) {
    if shortcut_item.is_null() {
        return;
    }
    // `type` is the NSString accessor; objc2's msg_send! macro accepts the
    // bare selector name even though `type` is a Rust keyword (this matches
    // tao's own usage pattern — see its iOS view.rs touch handling).
    let item_type: Retained<NSString> = unsafe { msg_send![shortcut_item, type] };
    let type_str = item_type.to_string();
    let Some(idx_str) = type_str.strip_prefix("recent-") else { return };
    let Ok(idx) = idx_str.parse::<usize>() else { return };

    if let Some(slot) = HANDLER.get() {
        if let Ok(guard) = slot.lock() {
            if let Some(h) = guard.as_ref() {
                h(idx);
            }
        }
    }
}
