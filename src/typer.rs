use enigo::{Direction, Enigo, Key, Keyboard, Settings};
use tracing::{debug, info};
use crate::{
    AI_SOLUTION, TYPING_INDEX,
    OVERRIDE_ACTIVE, SOLUTION_READY
};
use std::sync::atomic::Ordering;

pub fn type_next_char() {
    let solution = AI_SOLUTION.lock().unwrap().clone();

    if solution.is_empty() {
        debug!("No solution");
        OVERRIDE_ACTIVE.store(false, Ordering::SeqCst);
        return;
    }

    let chars: Vec<char> = solution.chars().collect();

    // Skip \r characters
    let mut idx = TYPING_INDEX.load(Ordering::SeqCst);
    while idx < chars.len() && chars[idx] == '\r' {
        idx += 1;
    }

    // Check if solution is complete
    if idx >= chars.len() {
        info!("Solution fully typed!");
        OVERRIDE_ACTIVE.store(false, Ordering::SeqCst);
        SOLUTION_READY.store(false, Ordering::SeqCst);
        TYPING_INDEX.store(0, Ordering::SeqCst);
        return;
    }

    TYPING_INDEX.store(idx, Ordering::SeqCst);
    let ch = chars[idx];

    debug!("Char [{}/{}]: {:?}", idx + 1, chars.len(), ch);

    let settings = Settings::default();
    if let Ok(mut enigo) = Enigo::new(&settings) {
        match ch {
            ' ' => {
                let _ = enigo.key(
                    Key::Space, Direction::Click
                );
            }
            '\n' => {
                let _ = enigo.key(
                    Key::Return, Direction::Click
                );
            }
            '\t' => {
                let _ = enigo.key(
                    Key::Tab, Direction::Click
                );
            }
            _ => {
                let _ = enigo.text(&ch.to_string());
            }
        }
    }

    TYPING_INDEX.fetch_add(1, Ordering::SeqCst);
}
