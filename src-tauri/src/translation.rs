use serde_json::Value;

fn parse_translation(value: &Value) -> Result<String, String> {
    let rows = value
        .get(0)
        .and_then(Value::as_array)
        .filter(|rows| !rows.is_empty())
        .ok_or("Google 번역 응답 형식이 변경되었거나 비어 있습니다.")?;
    let mut translated = String::new();
    for row in rows {
        let text = row
            .get(0)
            .and_then(Value::as_str)
            .ok_or("Google 번역 응답을 읽을 수 없습니다.")?;
        translated.push_str(text);
    }
    if translated.trim().is_empty() {
        return Err("Google 번역 결과가 비어 있습니다.".into());
    }
    Ok(translated)
}

#[tauri::command]
pub async fn translate_text(texts: Vec<String>) -> Result<Vec<String>, String> {
    // One request at a time: cancellation prevents the next text from being sent.
    if texts.len() != 1 || texts[0].trim().is_empty() || texts[0].chars().count() > 1000 {
        return Err("번역 요청 크기가 올바르지 않습니다.".into());
    }
    let client = reqwest::Client::builder()
        .user_agent("MDV/0.2")
        .timeout(std::time::Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "번역 연결을 준비할 수 없습니다.")?;
    // Undocumented endpoint also used by googletrans; no account, cookies or API key.
    let response = client
        .get("https://translate.googleapis.com/translate_a/single")
        .query(&[
            ("client", "gtx"),
            ("sl", "auto"),
            ("tl", "ko"),
            ("dt", "t"),
            ("q", texts[0].as_str()),
        ])
        .send()
        .await
        .map_err(|_| {
            "Google 번역에 연결할 수 없습니다. 인터넷 연결을 확인하거나 AI로 번역을 이용하세요."
        })?;
    if !response.status().is_success() {
        return Err(match response.status().as_u16() {
            403 | 429 => {
                "Google 번역이 요청을 제한했습니다. 잠시 후 다시 시도하거나 AI로 번역을 이용하세요."
            }
            _ => {
                "Google 번역을 사용할 수 없습니다. 잠시 후 다시 시도하거나 AI로 번역을 이용하세요."
            }
        }
        .into());
    }
    // Bound an unexpected response before parsing it.
    let mut response = response;
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "번역 응답을 읽을 수 없습니다.")?
    {
        if bytes.len() + chunk.len() > 1024 * 1024 {
            return Err("번역 응답이 너무 큽니다.".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|_| "Google 번역 응답이 올바르지 않습니다. AI로 번역을 이용하세요.")?;
    Ok(vec![parse_translation(&value)?])
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn joins_sentences_in_order() {
        assert_eq!(
            parse_translation(&json!([
                [["안녕하세요. ", "Hello."], ["문서입니다.", "Document."]],
                null,
                "en"
            ]))
            .unwrap(),
            "안녕하세요. 문서입니다."
        );
    }
    #[test]
    fn rejects_missing_or_changed_responses() {
        for value in [
            json!(null),
            json!({"error": "blocked"}),
            json!([]),
            json!([[]]),
            json!([[[null]]]),
            json!([[[""]]]),
        ] {
            assert!(parse_translation(&value).is_err());
        }
    }
}
