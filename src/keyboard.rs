//! Global keyboard hook
//! Intercepts ALL keypresses system-wide
//! When override is active:
//!   - Blocks the real key
//!   - Types next correct character from AI solution

use rdev::{listen, Event, EventType, Key};
use tracing::{info, debug};
use crate::{
    OVERRIDE_ACTIVE,
    SOLUTION_READY,
    AI_SOLUTION,
    TYPING_INDEX,
};
use std::sync::atomic::Ordering;

// Track modifier key states
static CTRL_DOWN: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);
static SHIFT_DOWN: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// Start the global keyboard hook
/// This runs forever and intercepts all keypresses
pub fn start_keyboard_hook() {
    info!("Keyboard hook started");

    if let Err(e) = listen(handle_key_event) {
        tracing::error!("Keyboard hook error: {:?}", e);
    }
}

/// Handle every keypress event
fn handle_key_event(event: Event) {
    match event.event_type {
        // ── KEY PRESS ──────────────────────────────
        EventType::KeyPress(key) => {
            match key {
                // Track modifier keys
                Key::ControlLeft | Key::ControlRight => {
                    CTRL_DOWN.store(true, Ordering::SeqCst);
                }
                Key::ShiftLeft | Key::ShiftRight => {
                    SHIFT_DOWN.store(true, Ordering::SeqCst);
                }

                // ACTIVATE: Ctrl+Shift+Z
                Key::KeyZ => {
                    if CTRL_DOWN.load(Ordering::SeqCst)
                        && SHIFT_DOWN.load(Ordering::SeqCst)
                    {
                        if SOLUTION_READY.load(Ordering::SeqCst) {
                            OVERRIDE_ACTIVE.store(true, Ordering::SeqCst);
                            info!("Typing mode ACTIVATED");
                        } else {
                            info!("Solution not ready yet");
                        }
                        return;
                    }

                    // If override active type next char
                    if OVERRIDE_ACTIVE.load(Ordering::SeqCst) {
                        type_next_char();
                    }
                }

                // CANCEL: Escape
                Key::Escape => {
                    if OVERRIDE_ACTIVE.load(Ordering::SeqCst) {
                        OVERRIDE_ACTIVE.store(false, Ordering::SeqCst);
                        info!("Typing mode DEACTIVATED");
                    }
                }

                // ANY OTHER KEY
                // If override is active intercept it
                // and type next correct character instead
                key => {
                    if OVERRIDE_ACTIVE.load(Ordering::SeqCst) {
                        // Only intercept letter and number keys
                        if is_typeable_key(&key) {
                            debug!("Key intercepted: {:?}", key);
                            type_next_char();
                        }
                    }
                }
            }
        }

        // ── KEY RELEASE ────────────────────────────
        EventType::KeyRelease(key) => {
            match key {
                Key::ControlLeft | Key::ControlRight => {
                    CTRL_DOWN.store(false, Ordering::SeqCst);
                }
                Key::ShiftLeft | Key::ShiftRight => {
                    SHIFT_DOWN.store(false, Ordering::SeqCst);
                }
                _ => {}
            }
        }

        _ => {}
    }
}

/// Type the next correct character from AI solution
fn type_next_char() {
    // Get solution
    let solution = AI_SOLUTION.lock().unwrap().clone();

    if solution.is_empty() {
        debug!("No solution available");
        return;
    }

    // Get current index
    let mut idx = TYPING_INDEX.lock().unwrap();

    if *idx >= solution.len() {
        // Finished typing entire solution
        info!("Solution fully typed");
        OVERRIDE_ACTIVE.store(false, Ordering::SeqCst);
        *idx = 0;
        return;
    }

    // Get next character
    let chars: Vec<char> = solution.chars().collect();
    let next_char = chars[*idx];

    debug!("Typing char {} at index {}", next_char, *idx);

    // Type it using enigo
    type_char_silently(next_char);

    // Move to next character
    *idx += 1;
}

/// Type a single character silently using enigo
fn type_char_silently(ch: char) {
    use enigo::{Enigo, Keyboard, Settings, Key, Direction};

    let settings = Settings::default();
    if let Ok(mut enigo) = Enigo::new(&settings) {
        match ch {
            ' ' => {
                let _ = enigo.key(Key::Space, Direction::Click);
            }
            '\n' => {
                let _ = enigo.key(Key::Return, Direction::Click);
            }
            '\t' => {
                let _ = enigo.key(Key::Tab, Direction::Click);
            }
            '\r' => {
                // Skip carriage return
            }
            _ => {
                let _ = enigo.text(&ch.to_string());
            }
        }
    }
}

/// Check if a key is a typeable character (letter or number)
fn is_typeable_key(key: &Key) -> bool {
    matches!(
        key,
        Key::KeyA | Key::KeyB | Key::KeyC | Key::KeyD |
        Key::KeyE | Key::KeyF | Key::KeyG | Key::KeyH |
        Key::KeyI | Key::KeyJ | Key::KeyK | Key::KeyL |
        Key::KeyM | Key::KeyN | Key::KeyO | Key::KeyP |
        Key::KeyQ | Key::KeyR | Key::KeyS | Key::KeyT |
        Key::KeyU | Key::KeyV | Key::KeyW | Key::KeyX |
        Key::KeyY | Key::KeyZ |
        Key::Num0 | Key::Num1 | Key::Num2 | Key::Num3 |
        Key::Num4 | Key::Num5 | Key::Num6 | Key::Num7 |
        Key::Num8 | Key::Num9 |
        Key::Space | Key::Return
    )
}