use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;
use std::io::{self, Write};
use base64::Engine;
use lazy_static::lazy_static;
use rand::Rng;
use enigo::{Enigo, Key, Keyboard, Settings};

use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GetMessageW, PeekMessageW, SetWindowsHookExW,
    UnhookWindowsHookEx, SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE,
    WH_KEYBOARD_LL, KBDLLHOOKSTRUCT, WM_KEYDOWN, WM_SYSKEYDOWN, PM_REMOVE, MSG
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, VK_BACK, VK_D, VK_F2, VK_P, VK_Q, VK_S, VK_T, VK_Z, VK_MENU
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;

// ==========================================
// GLOBAL STATE & ATOMICS
// ==========================================
lazy_static! {
    static ref SCREENSHOTS: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    static ref AI_SOLUTION: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
    static ref SELECTED_LANG: Arc<Mutex<String>> = Arc::new(Mutex::new("C++".to_string()));
    static ref HWID: String = machine_uid::get().unwrap_or_else(|_| "UNKNOWN_HWID".to_string());
}

static TYPING_ACTIVE: AtomicBool = AtomicBool::new(false);
static TYPING_PAUSED: AtomicBool = AtomicBool::new(false);
static OVERLAY_VISIBLE: AtomicBool = AtomicBool::new(true);


// ==========================================
// HWID & SECURITY SYSTEM
// ==========================================
fn verify_hardware_lock() -> bool {
    println!("\n========================================================");
    println!(" [🔒 HARDWARE LOCK ENFORCED]");
    println!("  Device HWID: {}", *HWID);
    println!("========================================================");
    
    print!("\n[?] Enter 8-digit Registration Number: ");
    io::stdout().flush().unwrap();

    let mut input_reg = String::new();
    io::stdin().read_line(&mut input_reg).unwrap();
    let input_reg = input_reg.trim();

    if input_reg.len() != 8 || !input_reg.chars().all(|c| c.is_ascii_digit()) {
        println!("[❌] Invalid Registration Code. Format must be 8 digits.");
        return false;
    }

    println!("[✅] License Validated for Device HWID: {}", *HWID);
    true
}

// ==========================================
// STEALTH DISPLAY AFFINITY (CAPTURE EXCLUSION)
// ==========================================
pub fn enable_stealth_capture_exclusion(hwnd: HWND) {
    unsafe {
        // WDA_EXCLUDEFROMCAPTURE hides the window from all screenshots, screen recording, and proctor scanners
        let _ = SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE);
    }
}

// ==========================================
// HUMANIZED TYPER ENGINE (ANTI-BOT DETECT)
// ==========================================
fn trigger_human_typing() {
    if TYPING_ACTIVE.load(Ordering::SeqCst) {
        println!("[!] Typing already in progress.");
        return;
    }

    let text = AI_SOLUTION.lock().unwrap().clone();
    if text.is_empty() {
        println!("[⚠️] No AI solution available to type. Press Alt+D first.");
        return;
    }

    println!("[🚀] Human Typing Started...");
    TYPING_ACTIVE.store(true, Ordering::SeqCst);
    TYPING_PAUSED.store(false, Ordering::SeqCst);

    tokio::task::spawn_blocking(move || {
        let mut enigo = Enigo::new(&Settings::default());
        let mut rng = rand::thread_rng();

        for ch in text.chars() {
            // Check panic / stop flags
            if !TYPING_ACTIVE.load(Ordering::SeqCst) {
                println!("[🛑] Typing Cancelled.");
                break;
            }

            // Check pause flag
            while TYPING_PAUSED.load(Ordering::SeqCst) {
                thread::sleep(Duration::from_millis(100));
                if !TYPING_ACTIVE.load(Ordering::SeqCst) {
                    println!("[🛑] Typing Cancelled while Paused.");
                    return;
                }
            }

            // Human Latency Jitter Logic
            let delay_ms = match ch {
                '\n' => rng.gen_range(350..700),           // Line break pause
                '.' | ';' | '{' | '}' => rng.gen_range(180..350), // Syntax pauses
                ',' | '(' | ')' | '[' | ']' => rng.gen_range(120..220),
                ' ' => rng.gen_range(60..130),
                _ => rng.gen_range(35..100),              // Natural typing speed
            };

            thread::sleep(Duration::from_millis(delay_ms));

            match ch {
                ' ' => { let _ = enigo.key(Key::Space, enigo::Direction::Click); }
                '\n' => { let _ = enigo.key(Key::Return, enigo::Direction::Click); }
                '\t' => { let _ = enigo.key(Key::Tab, enigo::Direction::Click); }
                _ => { let _ = enigo.text(&ch.to_string()); }
            }
        }

        TYPING_ACTIVE.store(false, Ordering::SeqCst);
        println!("[✅] Human Typing Finished.");
    });
}

// ==========================================
// SCREEN CAPTURE SYSTEM
// ==========================================
fn capture_screen_to_base64() -> Option<String> {
    let screens = screenshots::Screen::all().ok()?;
    let primary = screens.into_iter().find(|s| s.display_info.is_primary)
        .or_else(|| screenshots::Screen::all().ok()?.into_iter().next())?;

    let image = primary.capture().ok()?;
    let dynamic_img = image::DynamicImage::ImageRgba8(
        image::ImageBuffer::from_raw(image.width(), image.height(), image.rgba().to_vec())?
    );

    let mut buffer = std::io::Cursor::new(Vec::new());
    dynamic_img.write_to(&mut buffer, image::ImageFormat::Png).ok()?;
    Some(base64::engine::general_purpose::STANDARD.encode(buffer.into_inner()))
}

// ==========================================
// GROQ VISION AI INTEGRATION
// ==========================================
async fn request_ai_solution() {
    let images = SCREENSHOTS.lock().unwrap().clone();
    if images.is_empty() {
        println!("[⚠️] No screenshots in queue! Press Alt+S to capture first.");
        return;
    }

    let api_key = match std::env::var("GROQ_API_KEY") {
        Ok(key) if !key.trim().is_empty() => key,
        Ok(_) => {
            eprintln!("[ERROR] GROQ_API_KEY environment variable is empty.");
            return;
        }
        Err(_) => {
            eprintln!("[ERROR] Set GROQ_API_KEY before requesting an AI solution.");
            return;
        }
    };

    let lang = SELECTED_LANG.lock().unwrap().clone();
    println!("[⏳] Querying AI (Language: {} | Screenshots: {})...", lang, images.len());

    let client = reqwest::Client::new();
    let system_prompt = format!(
        "Target Language: {}\n\
        You are solving a programming task or MCQ question captured from screen.\n\
        Format rules:\n\
        - Remove all unnecessary spaces and blank lines\n\
        - Keep code compact and minified style\n\
        - No comments\n\
        - No extra text before or after code\n\
        - No markdown formatting, no backticks\n\
        - Output raw code or chosen MCQ option letter only",
        lang
    );

    let mut content_array = vec![serde_json::json!({
        "type": "text",
        "text": system_prompt
    })];

    for img in images {
        content_array.push(serde_json::json!({
            "type": "image_url",
            "image_url": {
                "url": format!("data:image/png;base64,{}", img)
            }
        }));
    }

    let body = serde_json::json!({
        "model": "meta-llama/llama-4-scout-17b-16e-instruct",
        "messages": [
            {
                "role": "user",
                "content": content_array
            }
        ],
        "temperature": 0.0,
        "max_tokens": 2048
    });

    let res = client.post("https://api.groq.com/openai/v1/chat/completions")
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await;

    match res {
        Ok(response) => {
            if let Ok(json_val) = response.json::<serde_json::Value>().await {
                if let Some(content) = json_val["choices"][0]["message"]["content"].as_str() {
                    let cleaned = content.trim().to_string();
                    *AI_SOLUTION.lock().unwrap() = cleaned.clone();
                    println!("\n[🎯 SOLUTION RECEIVED]:\n--------------------------------\n{}\n--------------------------------", cleaned);
                    println!("[💡] Press Alt+T to start human typing.");
                } else {
                    println!("[❌] Error reading AI response content.");
                }
            }
        }
        Err(e) => println!("[❌] Network error querying Groq API: {:?}", e),
    }
}

// ==========================================
// WIN32 LOW-LEVEL KEYBOARD HOOK (ALT HOTKEYS)
// ==========================================
unsafe extern "system" fn keyboard_hook_proc(n_code: i32, w_param: WPARAM, l_param: LPARAM) -> LRESULT {
    if n_code >= 0 {
        let kbd = *(l_param.0 as *const KBDLLHOOKSTRUCT);
        let is_sys_key = w_param.0 == WM_SYSKEYDOWN as usize || w_param.0 == WM_KEYDOWN as usize;
        let alt_pressed = (kbd.flags.0 & 0x20) != 0 || (GetAsyncKeyState(VK_MENU.0 as i32) & 0x8000 != 0);

        if is_sys_key {
            // F2: Toggle Overlay Visibility (No Alt required)
            if kbd.vkCode == VK_F2.0 as u32 {
                let current = OVERLAY_VISIBLE.load(Ordering::SeqCst);
                OVERLAY_VISIBLE.store(!current, Ordering::SeqCst);
                println!("[👁️] Overlay Visibility: {}", !current);
                return LRESULT(1);
            }

            // ALT COMBINATIONS
            if alt_pressed {
                match kbd.vkCode {
                    // Alt + S: Capture Screenshot
                    0x53 => { // VK_S
                        if let Some(base64_img) = capture_screen_to_base64() {
                            let mut queue = SCREENSHOTS.lock().unwrap();
                            queue.push(base64_img);
                            println!("[📸] Screenshot captured. Queue size: {}", queue.len());
                        }
                        return LRESULT(1);
                    }
                    // Alt + Backspace: Remove Last Screenshot
                    0x08 => { // VK_BACK
                        let mut queue = SCREENSHOTS.lock().unwrap();
                        if queue.pop().is_some() {
                            println!("[🗑️] Last screenshot removed. Queue size: {}", queue.len());
                        } else {
                            println!("[⚠️] Screenshot queue is already empty.");
                        }
                        return LRESULT(1);
                    }
                    // Alt + D: Send Queue to AI
                    0x44 => { // VK_D
                        tokio::spawn(async {
                            request_ai_solution().await;
                        });
                        return LRESULT(1);
                    }
                    // Alt + T: Start Typing Answer
                    0x54 => { // VK_T
                        trigger_human_typing();
                        return LRESULT(1);
                    }
                    // Alt + P: Pause / Resume Typing
                    0x50 => { // VK_P
                        if TYPING_ACTIVE.load(Ordering::SeqCst) {
                            let paused = TYPING_PAUSED.load(Ordering::SeqCst);
                            TYPING_PAUSED.store(!paused, Ordering::SeqCst);
                            println!("[⏸️] Typing Paused: {}", !paused);
                        }
                        return LRESULT(1);
                    }
                    // Alt + Z: Panic Mode
                    0x5A => { // VK_Z
                        TYPING_ACTIVE.store(false, Ordering::SeqCst);
                        OVERLAY_VISIBLE.store(false, Ordering::SeqCst);
                        SCREENSHOTS.lock().unwrap().clear();
                        println!("[🚨 PANIC MODE ACTIVATED] Stopped typing, cleared queue, hid overlay.");
                        return LRESULT(1);
                    }
                    // Alt + Q: Quit App
                    0x51 => { // VK_Q
                        println!("[👋] Exiting GhostAI system.");
                        std::process::exit(0);
                    }
                    _ => {}
                }
            }
        }
    }
    CallNextHookEx(None, n_code, w_param, l_param)
}

// ==========================================
// MAIN ENTRY POINT
// ==========================================
#[tokio::main]
async fn main() {
    println!("=== GHOST AI ENHANCED SYSTEM v2.0 ===");

    if !verify_hardware_lock() {
        println!("[❌] HWID Authentication failed. Tool locked.");
        return;
    }

    println!("\nSelect Programming Language Setup:");
    println!(" [1] C++");
    println!(" [2] Java");
    println!(" [3] C");
    print!("[?] Choose (1-3) [Default 1]: ");
    io::stdout().flush().unwrap();

    let mut choice = String::new();
    io::stdin().read_line(&mut choice).unwrap();
    let chosen_lang = match choice.trim() {
        "2" => "Java",
        "3" => "C",
        _ => "C++",
    };

    *SELECTED_LANG.lock().unwrap() = chosen_lang.to_string();
    println!("[✅] Language locked to: {}", chosen_lang);

    println!("\n========================================================");
    println!(" ⌨️ HOTKEY MAP ACTIVE:");
    println!("  • Alt + S         : Capture Screenshot (Queue)");
    println!("  • Alt + Backspace : Remove Last Screenshot");
    println!("  • Alt + D         : Send Queue to AI");
    println!("  • Alt + T         : Start Human Typing");
    println!("  • Alt + P         : Pause / Resume Typing");
    println!("  • F2              : Toggle Stealth Overlay");
    println!("  • Alt + Z         : Panic Mode (Hide & Cancel)");
    println!("  • Alt + Q         : Quit System");
    println!("========================================================\n");

    // Install Global Win32 Hook
    unsafe {
        let h_instance = GetModuleHandleW(None).unwrap();
        let hook = SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_hook_proc), h_instance, 0);

        if hook.is_err() {
            println!("[❌] Failed to install keyboard hook. Run as Administrator!");
            return;
        }
        println!("[🛡️] Low-Level Win32 Stealth Hook Registered.");

        // Windows Event Loop
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, HWND(0), 0, 0).into() {
            DispatchMessageW(&msg);
            PeekMessageW(&msg, HWND(0), 0, 0, PM_REMOVE);
        }

        let _ = UnhookWindowsHookEx(hook.unwrap());
    }
}