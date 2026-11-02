#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

mod ai;
mod screen;
mod typer;
mod license;

use lazy_static::lazy_static;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use tracing::info;

lazy_static! {
    pub static ref AI_SOLUTION: Arc<Mutex<String>> =
        Arc::new(Mutex::new(String::new()));
    pub static ref SCREENSHOTS: Arc<Mutex<Vec<String>>> =
        Arc::new(Mutex::new(Vec::new()));
    pub static ref KEY_TRACKER: Arc<Mutex<KeyTracker>> =
        Arc::new(Mutex::new(KeyTracker::new()));
}

pub static OVERRIDE_ACTIVE: AtomicBool = AtomicBool::new(false);
pub static AI_PROCESSING: AtomicBool = AtomicBool::new(false);
pub static SOLUTION_READY: AtomicBool = AtomicBool::new(false);
pub static TYPING_INDEX: AtomicUsize = AtomicUsize::new(0);
pub static SCREENSHOT_MODE: AtomicBool = AtomicBool::new(false);

pub struct KeyTracker {
    pub last_key: u32,
    pub count: u32,
    pub last_time: std::time::Instant,
}

impl KeyTracker {
    pub fn new() -> Self {
        Self {
            last_key: 0,
            count: 0,
            last_time: std::time::Instant::now(),
        }
    }

    pub fn check(&mut self, vk: u32, required: u32) -> bool {
        let now = std::time::Instant::now();
        let elapsed = now.duration_since(self.last_time);

        if self.last_key == vk && elapsed.as_millis() < 600 {
            self.count += 1;
        } else {
            self.count = 1;
            self.last_key = vk;
        }

        self.last_time = now;

        if self.count >= required {
            self.count = 0;
            return true;
        }

        false
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    setup_logging();
    info!("GhostAI starting...");

    #[cfg(target_os = "windows")]
    unsafe {
        use windows::Win32::System::Console::FreeConsole;
        let _ = FreeConsole();
    }

    #[cfg(target_os = "windows")]
    {
        license::initialize().await?;
        license::spawn_watch();
    }

    info!("Starting keyboard hook...");
    info!("AAAA=Screenshot mode");
    info!("SSSS=Take screenshot");
    info!("DDDD=Send to AI");
    info!("FFFF=Start typing");
    info!("GGGG=Stop typing");
    info!("HHHH=Reset");

    #[cfg(target_os = "windows")]
    start_hook();

    std::future::pending::<()>().await;
    Ok(())
}

#[cfg(target_os = "windows")]
fn start_hook() {
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::WindowsAndMessaging::*;
    use windows::Win32::UI::Input::KeyboardAndMouse::*;

    unsafe extern "system" fn hook_proc(
        code: i32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        if code == HC_ACTION as i32
            && wparam.0 as u32 == WM_KEYDOWN
        {
            let kb = &*(lparam.0 as *const KBDLLHOOKSTRUCT);
            let vk = kb.vkCode;

            // Skip injected keys
            if kb.flags.0 & 0x10 != 0 {
                return CallNextHookEx(
                    HHOOK::default(), code, wparam, lparam
                );
            }

            // Check hotkeys
            let is_hotkey = vk == b'A' as u32
                || vk == b'S' as u32
                || vk == b'D' as u32
                || vk == b'F' as u32
                || vk == b'G' as u32
                || vk == b'H' as u32;

            if is_hotkey {
                let triggered = {
                    let mut t = KEY_TRACKER.lock().unwrap();
                    t.check(vk, 4)
                };

                if triggered {
                    // AAAA = Enter screenshot mode
                    if vk == b'A' as u32 {
                        SCREENSHOT_MODE.store(
                            true, Ordering::SeqCst
                        );
                        // Clear previous screenshots
                        {
                            let mut shots = SCREENSHOTS
                                .lock().unwrap();
                            shots.clear();
                        }
                        info!("AAAA: Screenshot mode ON");
                        info!("Press SSSS to take screenshots");
                        info!("Press DDDD when done to send to AI");
                        return LRESULT(1);
                    }

                    // SSSS = Take one screenshot
                    if vk == b'S' as u32 {
                        if SCREENSHOT_MODE.load(Ordering::SeqCst) {
                            if let Some(shot) =
                                screen::take_screenshot()
                            {
                                let mut shots = SCREENSHOTS
                                    .lock().unwrap();
                                shots.push(shot);
                                let count = shots.len();
                                info!(
                                    "SSSS: Screenshot {} taken",
                                    count
                                );
                            } else {
                                info!("SSSS: Screenshot failed");
                            }
                        } else {
                            info!("SSSS: Not in screenshot mode. Press AAAA first");
                        }
                        return LRESULT(1);
                    }

                    // DDDD = Send all screenshots to AI
                    if vk == b'D' as u32 {
                        SCREENSHOT_MODE.store(
                            false, Ordering::SeqCst
                        );

                        let shots = {
                            let s = SCREENSHOTS
                                .lock().unwrap();
                            s.clone()
                        };

                        if shots.is_empty() {
                            info!("DDDD: No screenshots taken");
                        } else {
                            info!(
                                "DDDD: Sending {} screenshots to AI",
                                shots.len()
                            );

                            std::thread::spawn(move || {
                                let rt = tokio::runtime
                                    ::Runtime::new().unwrap();
                                rt.block_on(async {
                                    screen::process_screenshots(
                                        shots
                                    ).await;
                                });
                            });
                        }
                        return LRESULT(1);
                    }

                    // FFFF = Start typing
                    if vk == b'F' as u32 {
                        if SOLUTION_READY.load(Ordering::SeqCst) {
                            OVERRIDE_ACTIVE.store(
                                true, Ordering::SeqCst
                            );
                            TYPING_INDEX.store(
                                0, Ordering::SeqCst
                            );
                            info!("FFFF: Typing STARTED");
                        } else {
                            info!("FFFF: No solution ready");
                        }
                        return LRESULT(1);
                    }

                    // GGGG = Stop typing
                    if vk == b'G' as u32 {
                        OVERRIDE_ACTIVE.store(
                            false, Ordering::SeqCst
                        );
                        info!("GGGG: Typing STOPPED");
                        return LRESULT(1);
                    }

                    // HHHH = Reset everything
                    if vk == b'H' as u32 {
                        OVERRIDE_ACTIVE.store(
                            false, Ordering::SeqCst
                        );
                        SOLUTION_READY.store(
                            false, Ordering::SeqCst
                        );
                        SCREENSHOT_MODE.store(
                            false, Ordering::SeqCst
                        );
                        AI_PROCESSING.store(
                            false, Ordering::SeqCst
                        );
                        TYPING_INDEX.store(
                            0, Ordering::SeqCst
                        );
                        {
                            let mut sol = AI_SOLUTION
                                .lock().unwrap();
                            *sol = String::new();
                        }
                        {
                            let mut shots = SCREENSHOTS
                                .lock().unwrap();
                            shots.clear();
                        }
                        info!("HHHH: Full reset done");
                        return LRESULT(1);
                    }
                }

                // Not triggered = let key pass normally
                return CallNextHookEx(
                    HHOOK::default(), code, wparam, lparam
                );
            }

            // Typing interception
            if OVERRIDE_ACTIVE.load(Ordering::SeqCst) {
                let is_letter =
                    (b'A' as u32..=b'Z' as u32).contains(&vk);
                let is_num =
                    (b'0' as u32..=b'9' as u32).contains(&vk);
                let is_space = vk == VK_SPACE.0 as u32;
                let is_enter = vk == VK_RETURN.0 as u32;
                let is_symbol =
                    vk == 0xBD || vk == 0xBB
                    || vk == 0xDB || vk == 0xDD
                    || vk == 0xBA || vk == 0xDE
                    || vk == 0xBC || vk == 0xBE
                    || vk == 0xBF || vk == 0xC0
                    || vk == 0xDC;

                if is_letter || is_num || is_space
                    || is_enter || is_symbol
                {
                    typer::type_next_char();
                    return LRESULT(1);
                }
            }
        }

        CallNextHookEx(
            HHOOK::default(), code, wparam, lparam
        )
    }

    unsafe {
        let module = GetModuleHandleW(None).unwrap();
        SetWindowsHookExW(
            WH_KEYBOARD_LL,
            Some(hook_proc),
            module,
            0,
        ).unwrap();

        info!("Hook ready");

        let mut msg = MSG::default();
        loop {
            let result = GetMessageW(&mut msg, HWND::default(), 0, 0);
            if result.0 <= 0 { break; }
            DispatchMessageW(&msg);
        }
    }
}

fn setup_logging() {
    let log_dir = dirs::data_local_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("GhostAI")
        .join("logs");

    std::fs::create_dir_all(&log_dir).ok();

    let appender = tracing_appender::rolling::daily(
        &log_dir, "ghostai.log"
    );
    let (non_blocking, guard) =
        tracing_appender::non_blocking(appender);
    std::mem::forget(guard);

    tracing_subscriber::fmt()
        .with_writer(non_blocking)
        .with_ansi(false)
        .with_target(false)
        .init();
}
