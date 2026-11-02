use tracing::{info, error};

const GROQ_API_KEY: &str = "gsk_LtXdIfdM3YR4Pp9LNZ1QWGdyb3FYE8A";
const GROQ_URL: &str = "https://api.groq.com/openai/v1/chat/completions";
const MODEL_VISION: &str = "qwen/qwen3.8-27b";
const MODEL_TEXT: &str = "openai/gpt-oss-120b";

pub async fn ask_with_multi_screenshot(
    screenshots: Vec<String>,
) -> Result<String, Box<dyn std::error::Error>> {
    info!("AI call: {} screenshots", screenshots.len());

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(90))
        .build()?;

    let mut content: Vec<serde_json::Value> = Vec::new();

    content.push(serde_json::json!({
        "type": "text",
        "text": "These are screenshots of a coding problem from top to bottom."
    }));

    for (i, b64) in screenshots.iter().enumerate() {
        content.push(serde_json::json!({
            "type": "text",
            "text": format!("Screenshot {} of {}:", i + 1, screenshots.len())
        }));
        content.push(serde_json::json!({
            "type": "image_url",
            "image_url": {
                "url": format!("data:image/png;base64,{}", b64)
            }
        }));
    }

    content.push(serde_json::json!({
        "type": "text",
        "text": get_user_prompt()
    }));

    let body = serde_json::json!({
        "model": MODEL_VISION,
        "messages": [
            {
                "role": "system",
                "content": get_system_prompt()
            },
            {
                "role": "user",
                "content": content
            }
        ],
        "temperature": 0.0,
        "max_tokens": 8192
    });

    call_api(client, body).await
}

pub async fn ask_with_screenshot(
    screenshot: String,
) -> Result<String, Box<dyn std::error::Error>> {
    ask_with_multi_screenshot(vec![screenshot]).await
}

pub async fn ask_with_context(
    page_text: String,
    screenshot: String,
) -> Result<String, Box<dyn std::error::Error>> {
    info!("AI: text + screenshot");

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()?;

    let body = serde_json::json!({
        "model": MODEL_VISION,
        "messages": [
            {
                "role": "system",
                "content": get_system_prompt()
            },
            {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": format!(
                            "Page text:\n{}",
                            &page_text[..page_text.len().min(3000)]
                        )
                    },
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": format!(
                                "data:image/png;base64,{}",
                                screenshot
                            )
                        }
                    },
                    {
                        "type": "text",
                        "text": get_user_prompt()
                    }
                ]
            }
        ],
        "temperature": 0.0,
        "max_tokens": 8192
    });

    call_api(client, body).await
}

pub async fn ask_groq_smart_text(
    problem: &str,
) -> Result<String, Box<dyn std::error::Error>> {
    info!("AI: text only");

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()?;

    let body = serde_json::json!({
        "model": MODEL_TEXT,
        "messages": [
            {
                "role": "system",
                "content": get_system_prompt()
            },
            {
                "role": "user",
                "content": format!(
                    "{}\n\nProblem:\n{}",
                    get_user_prompt(),
                    &problem[..problem.len().min(4000)]
                )
            }
        ],
        "temperature": 0.0,
        "max_tokens": 8192,
        "stream": false
    });

    call_api(client, body).await
}

async fn call_api(
    client: reqwest::Client,
    body: serde_json::Value,
) -> Result<String, Box<dyn std::error::Error>> {
    let res = client
        .post(GROQ_URL)
        .header(
            "Authorization",
            format!("Bearer {}", GROQ_API_KEY)
        )
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await?;

    let status = res.status();
    info!("API status: {}", status);

    let raw = res.text().await?;
    info!("Response: {}", &raw[..raw.len().min(300)]);

    let json: serde_json::Value = serde_json::from_str(&raw)?;

    if let Some(content) = json["choices"][0]["message"]["content"]
        .as_str()
    {
        return Ok(clean_response(content));
    }

    if let Some(err) = json["error"]["message"].as_str() {
        error!("API error: {}", err);
        return Err(err.into());
    }

    Err("No content".into())
}

fn get_system_prompt() -> String {
    String::from(
        "Give me only the code (no explanation). \
Format rules: \
Remove all unnecessary spaces and blank lines. \
Keep code compact and minified style. \
No comments. \
No extra text before or after code. \
Keep everything as tight as possible but still valid syntax. \
No markdown. \
No backticks. \
Output raw code only. \
Do not repeat existing code. \
If a template exists give only the missing body. \
Keep line breaks between statements. \
Use minimal spaces only where required by language syntax."
    )
}

fn get_user_prompt() -> &'static str {
    "Give me only the code (no explanation).

Format rules:
- Remove all unnecessary spaces and blank lines
- Keep code compact and minified style
- No comments
- No extra text before or after code
- Keep everything as tight as possible but still valid syntax
- No markdown
- No backticks
- Output raw code only
- Do not repeat existing code
- If a template exists give only the missing body"
}

fn clean_response(raw: &str) -> String {
    let mut s = raw.trim().to_string();

    if s.starts_with("```") {
        if let Some(pos) = s.find('\n') {
            s = s[pos + 1..].to_string();
        }
    }

    let trimmed = s.trim_end().to_string();
    if trimmed.ends_with("```") {
        s = trimmed[..trimmed.len() - 3].to_string();
    }

    s = s.replace("```", "");

    // Remove lines that look like explanations
    let lines: Vec<&str> = s
        .lines()
        .filter(|line| {
            let l = line.to_lowercase();
            !l.starts_with("here is")
                && !l.starts_with("here's")
                && !l.starts_with("the code")
                && !l.starts_with("this code")
                && !l.starts_with("solution")
                && !l.starts_with("output")
                && !l.starts_with("note")
                && !l.starts_with("explanation")
        })
        .collect();

    s = lines.join("\n");
    s.trim().to_string()
}
