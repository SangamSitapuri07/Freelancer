use rand::Rng; // Add rand = "0.8" to Cargo.toml
use std::thread;
use std::time::Duration;
use enigo::{Enigo, Keyboard, Settings, Key};

pub fn type_next_char(enigo: &mut Enigo, text: &str, index: usize) {
    let chars: Vec<char> = text.chars().collect();
    if index >= chars.len() { return; }

    let ch = chars[index];
    
    // Human Latency Logic
    let mut rng = rand::thread_rng();
    let delay = match ch {
        '\n' => rng.gen_range(400..800), // Longer pause for new lines
        '.' | ';' | '{' | '}' => rng.gen_range(200..400), // Pause for syntax
        _ => rng.gen_range(35..110), // Normal typing speed
    };

    thread::sleep(Duration::from_millis(delay));

    match ch {
        ' ' => { let _ = enigo.key(Key::Space, enigo::Direction::Click); }
        '\n' => { let _ = enigo.key(Key::Return, enigo::Direction::Click); }
        '\t' => { let _ = enigo.key(Key::Tab, enigo::Direction::Click); }
        _ => { let _ = enigo.text(&ch.to_string()); }
    }
}