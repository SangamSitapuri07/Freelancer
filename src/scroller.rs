//! Scroll utilities
//! Used to scroll through long coding problems

use std::time::Duration;

/// Scroll to absolute top of page
pub fn scroll_to_top() {
    use enigo::{Enigo, Key, Keyboard, Settings, Direction};
    let settings = Settings::default();
    if let Ok(mut enigo) = Enigo::new(&settings) {
        let _ = enigo.key(Key::Control, Direction::Press);
        let _ = enigo.key(Key::Home, Direction::Click);
        let _ = enigo.key(Key::Control, Direction::Release);
    }
}

/// Scroll down one full page
pub fn scroll_down() {
    use enigo::{Enigo, Key, Keyboard, Settings, Direction};
    let settings = Settings::default();
    if let Ok(mut enigo) = Enigo::new(&settings) {
        let _ = enigo.key(Key::PageDown, Direction::Click);
    }
}

/// Check if we have reached the bottom
/// by comparing two consecutive screenshots
pub fn is_at_bottom(shot1: &str, shot2: &str) -> bool {
    // If two consecutive screenshots are identical
    // we have reached the bottom
    shot1 == shot2
}