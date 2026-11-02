use tracing::info;

/// Send screenshots through the owner-controlled Rust server.
/// No provider API key is present in the desktop client.
pub async fn ask_with_multi_screenshot(
    screenshots: Vec<String>,
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    info!("AI call through control server: {} screenshots", screenshots.len());
    let language = crate::license::preferred_language();
    Ok(crate::license::assist(screenshots, &language).await?)
}

pub async fn ask_with_screenshot(
    screenshot: String,
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    ask_with_multi_screenshot(vec![screenshot]).await
}
