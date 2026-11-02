use tracing::{info, error};
use crate::{
    AI_SOLUTION, AI_PROCESSING,
    SOLUTION_READY, TYPING_INDEX
};
use std::sync::atomic::Ordering;

pub fn take_screenshot() -> Option<String> {
    use screenshots::Screen;
    use base64::Engine;
    use std::io::Cursor;

    let screens = Screen::all().ok()?;
    let screen = screens.first()?;
    let img = screen.capture().ok()?;

    let width = img.width();
    let height = img.height();
    let raw = img.into_raw();

    let dynamic = image::DynamicImage::ImageRgba8(
        image::ImageBuffer::from_raw(width, height, raw)?
    );

    let mut buffer: Vec<u8> = Vec::new();
    let mut cursor = Cursor::new(&mut buffer);

    dynamic.write_to(
        &mut cursor,
        image::ImageFormat::Png
    ).ok()?;

    Some(
        base64::engine::general_purpose::STANDARD
            .encode(&buffer)
    )
}

pub async fn process_screenshots(screenshots: Vec<String>) {
    if AI_PROCESSING.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
        info!("An AI request is already processing");
        return;
    }
    SOLUTION_READY.store(false, Ordering::SeqCst);

    info!("Processing {} screenshots...", screenshots.len());

    match crate::ai::ask_with_multi_screenshot(screenshots).await {
        Ok(solution) if !solution.is_empty() => {
            info!("Solution: {} chars", solution.len());

            // Copy to clipboard
            if let Ok(mut cb) = arboard::Clipboard::new() {
                let _ = cb.set_text(&solution);
                info!("Solution copied to clipboard");
            }

            // Store for typing
            {
                let mut sol = AI_SOLUTION.lock().unwrap();
                *sol = solution;
            }

            TYPING_INDEX.store(0, Ordering::SeqCst);
            SOLUTION_READY.store(true, Ordering::SeqCst);
            crate::SCREENSHOTS.lock().unwrap().clear();

            info!("READY!");
            info!("Solution is in clipboard (Ctrl+V to see)");
            info!("Press FFFF to start typing");
            info!("Press GGGG to stop typing");
            info!("Press HHHH to reset for next question");
        }
        Ok(_) => error!("Empty solution from AI"),
        Err(e) => error!("AI error: {}", e),
    }

    AI_PROCESSING.store(false, Ordering::SeqCst);
}