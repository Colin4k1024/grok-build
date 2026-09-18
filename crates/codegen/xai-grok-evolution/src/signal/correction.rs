//! Cross-turn user-correction intent detection.
//!
//! This intentionally stays deterministic: correction signals influence
//! experience selection, so a network classifier would make the signal path
//! unavailable offline and introduce a recursive dependency on sampling.

use super::UserCorrection;

const MAX_SIGNAL_CHARS: usize = 2_000;

/// Detect whether a genuine user message corrects the preceding assistant
/// action. The detector uses high-precision discourse markers in English and
/// Chinese. It deliberately ignores bare negative requirements (for example
/// "do not use unwrap") unless they also refer to the preceding response or
/// contrast it with the desired action.
pub fn detect_user_correction(
    previous_assistant_action: &str,
    current_user_message: &str,
) -> Option<UserCorrection> {
    let original = previous_assistant_action.trim();
    let correction = current_user_message.trim();
    if original.is_empty() || correction.is_empty() {
        return None;
    }

    let normalized = correction.to_lowercase();
    let strong = [
        "that's wrong",
        "that is wrong",
        "you are wrong",
        "you got it wrong",
        "not what i asked",
        "not what i meant",
        "i said ",
        "i meant ",
        "不对",
        "错了",
        "搞错",
        "不是我说的",
        "不是我要的",
        "我说的是",
        "我的意思是",
        "理解错",
    ]
    .iter()
    .any(|marker| normalized.contains(marker));

    let refers_to_previous = [
        "you ",
        "your ",
        "that ",
        "previous",
        "earlier",
        "last response",
        "刚才",
        "上次",
        "之前",
        "你",
        "这个实现",
        "这次修改",
    ]
    .iter()
    .any(|marker| normalized.contains(marker));
    let contrast = [
        " instead",
        "rather than",
        "should be",
        "change it to",
        "use ",
        "而不是",
        "应该",
        "改成",
        "改为",
        "要的是",
        "不要这样",
        "重新",
    ]
    .iter()
    .any(|marker| normalized.contains(marker));

    if !strong && !(refers_to_previous && contrast) {
        return None;
    }

    Some(UserCorrection {
        original_action: truncate_chars(original, MAX_SIGNAL_CHARS),
        correction: truncate_chars(correction, MAX_SIGNAL_CHARS),
    })
}

fn truncate_chars(value: &str, max: usize) -> String {
    let mut chars = value.chars();
    let head: String = chars.by_ref().take(max).collect();
    if chars.next().is_some() {
        format!("{head}…")
    } else {
        head
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_explicit_english_correction() {
        let got = detect_user_correction(
            "I changed the timeout to 10 seconds.",
            "That's wrong; I meant 10 minutes, not 10 seconds.",
        )
        .expect("correction");
        assert!(got.original_action.contains("10 seconds"));
        assert!(got.correction.contains("10 minutes"));
    }

    #[test]
    fn detects_chinese_contrast_correction() {
        assert!(
            detect_user_correction(
                "我删除了兼容入口。",
                "你理解错了，应该保留兼容入口，而不是删除。"
            )
            .is_some()
        );
    }

    #[test]
    fn ignores_new_negative_requirement() {
        assert!(
            detect_user_correction(
                "The first task is complete.",
                "For the next task, do not use unwrap."
            )
            .is_none()
        );
    }

    #[test]
    fn ignores_plain_follow_up() {
        assert!(
            detect_user_correction("Implemented the parser.", "Please add tests too.").is_none()
        );
    }
}
