use super::types::{FailedTest, TestSyncOutput};

pub fn parse_output(framework: &str, output: &str, command_run: &str, duration_ms: u64) -> TestSyncOutput {
    match framework {
        "cargo" => parse_cargo(output, command_run, duration_ms),
        "jest" => parse_jest(output, command_run, duration_ms),
        "vitest" => parse_vitest(output, command_run, duration_ms),
        "go" => parse_go(output, command_run, duration_ms),
        "pytest" => parse_pytest(output, command_run, duration_ms),
        _ => parse_generic(framework, output, command_run, duration_ms),
    }
}

fn parse_cargo(output: &str, command_run: &str, duration_ms: u64) -> TestSyncOutput {
    let mut passed = 0usize;
    let mut failed = 0usize;
    let mut ignored = 0usize;
    let mut failed_tests = Vec::new();

    for line in output.lines() {
        let Ok(val) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let typ = val.get("type").and_then(|t| t.as_str()).unwrap_or("");
        let event = val.get("event").and_then(|e| e.as_str()).unwrap_or("");

        if typ == "test" {
            match event {
                "ok" => passed += 1,
                "failed" => {
                    failed += 1;
                    let name = val.get("name").and_then(|n| n.as_str()).unwrap_or("unknown").to_string();
                    let stdout = val.get("stdout").and_then(|s| s.as_str()).unwrap_or("");
                    let message = stdout.lines().take(5).collect::<Vec<_>>().join("\n");
                    failed_tests.push(FailedTest { name, message });
                }
                "ignored" => ignored += 1,
                _ => {}
            }
        }
    }

    let total = passed + failed + ignored;
    TestSyncOutput {
        framework: "cargo".to_string(),
        command_run: command_run.to_string(),
        total,
        passed,
        failed,
        skipped: ignored,
        duration_ms,
        failed_tests,
        summary: format!("{} passed, {} failed, {} ignored", passed, failed, ignored),
    }
}

fn parse_jest(output: &str, command_run: &str, duration_ms: u64) -> TestSyncOutput {
    let json_start = output.find('{');
    let json_str = json_start.map(|i| &output[i..]).unwrap_or(output);

    if let Ok(val) = serde_json::from_str::<serde_json::Value>(json_str) {
        let num_passed = val.get("numPassedTests").and_then(|n| n.as_u64()).unwrap_or(0) as usize;
        let num_failed = val.get("numFailedTests").and_then(|n| n.as_u64()).unwrap_or(0) as usize;
        let num_pending = val.get("numPendingTests").and_then(|n| n.as_u64()).unwrap_or(0) as usize;
        let total = val.get("numTotalTests").and_then(|n| n.as_u64()).unwrap_or(0) as usize;

        let mut failed_tests = Vec::new();
        if let Some(results) = val.get("testResults").and_then(|r| r.as_array()) {
            for suite in results {
                if let Some(tests) = suite.get("assertionResults").and_then(|a| a.as_array()) {
                    for test in tests {
                        let status = test.get("status").and_then(|s| s.as_str()).unwrap_or("");
                        if status == "failed" {
                            let name = test.get("fullName").and_then(|n| n.as_str())
                                .or_else(|| test.get("title").and_then(|n| n.as_str()))
                                .unwrap_or("unknown").to_string();
                            let messages = test.get("failureMessages")
                                .and_then(|m| m.as_array())
                                .map(|arr| arr.iter()
                                    .filter_map(|v| v.as_str())
                                    .take(2)
                                    .collect::<Vec<_>>()
                                    .join("\n"))
                                .unwrap_or_default();
                            failed_tests.push(FailedTest { name, message: messages });
                        }
                    }
                }
            }
        }

        return TestSyncOutput {
            framework: "jest".to_string(),
            command_run: command_run.to_string(),
            total,
            passed: num_passed,
            failed: num_failed,
            skipped: num_pending,
            duration_ms,
            failed_tests,
            summary: format!("{} passed, {} failed, {} pending", num_passed, num_failed, num_pending),
        };
    }

    parse_generic("jest", output, command_run, duration_ms)
}

fn parse_vitest(output: &str, command_run: &str, duration_ms: u64) -> TestSyncOutput {
    parse_jest(output, command_run, duration_ms)
}

fn parse_go(output: &str, command_run: &str, duration_ms: u64) -> TestSyncOutput {
    let mut passed = 0usize;
    let mut failed = 0usize;
    let mut skipped = 0usize;
    let mut failed_tests = Vec::new();

    for line in output.lines() {
        let Ok(val) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let action = val.get("Action").and_then(|a| a.as_str()).unwrap_or("");
        let test = val.get("Test").and_then(|t| t.as_str());

        if test.is_none() {
            continue;
        }

        match action {
            "pass" => passed += 1,
            "fail" => {
                failed += 1;
                let name = test.unwrap_or("unknown").to_string();
                let out = val.get("Output").and_then(|o| o.as_str()).unwrap_or("").to_string();
                failed_tests.push(FailedTest { name, message: out });
            }
            "skip" => skipped += 1,
            _ => {}
        }
    }

    let total = passed + failed + skipped;
    TestSyncOutput {
        framework: "go".to_string(),
        command_run: command_run.to_string(),
        total,
        passed,
        failed,
        skipped,
        duration_ms,
        failed_tests,
        summary: format!("{} passed, {} failed, {} skipped", passed, failed, skipped),
    }
}

fn parse_pytest(output: &str, command_run: &str, duration_ms: u64) -> TestSyncOutput {
    let mut passed = 0usize;
    let mut failed = 0usize;
    let mut skipped = 0usize;
    let mut failed_tests = Vec::new();
    let mut current_fail_name: Option<String> = None;
    let mut current_fail_lines: Vec<String> = Vec::new();

    for line in output.lines() {
        if line.contains(" PASSED") {
            passed += 1;
        } else if line.contains(" FAILED") {
            failed += 1;
            let name = line.split_whitespace().next().unwrap_or("unknown").to_string();
            failed_tests.push(FailedTest {
                name: name.clone(),
                message: String::new(),
            });
        } else if line.contains(" SKIPPED") || line.contains(" XFAIL") {
            skipped += 1;
        } else if line.starts_with("FAILED ") || line.starts_with("_ ") {
            if let Some(ref name) = current_fail_name {
                if let Some(ft) = failed_tests.iter_mut().find(|t| &t.name == name) {
                    ft.message = current_fail_lines.join("\n");
                }
            }
            current_fail_name = line.strip_prefix("FAILED ").map(|s| s.to_string());
            current_fail_lines.clear();
        } else if current_fail_name.is_some() {
            current_fail_lines.push(line.to_string());
        }
    }

    // Flush last failure
    if let Some(ref name) = current_fail_name {
        if let Some(ft) = failed_tests.iter_mut().find(|t| &t.name == name) {
            ft.message = current_fail_lines.join("\n");
        }
    }

    // Try parsing the summary line: "X passed, Y failed, Z skipped"
    if passed == 0 && failed == 0 {
        for line in output.lines().rev() {
            if line.contains("passed") || line.contains("failed") {
                if let Some(p) = extract_count(line, "passed") {
                    passed = p;
                }
                if let Some(f) = extract_count(line, "failed") {
                    failed = f;
                }
                if let Some(s) = extract_count(line, "skipped") {
                    skipped = s;
                }
                break;
            }
        }
    }

    let total = passed + failed + skipped;
    TestSyncOutput {
        framework: "pytest".to_string(),
        command_run: command_run.to_string(),
        total,
        passed,
        failed,
        skipped,
        duration_ms,
        failed_tests,
        summary: format!("{} passed, {} failed, {} skipped", passed, failed, skipped),
    }
}

fn parse_generic(framework: &str, output: &str, command_run: &str, duration_ms: u64) -> TestSyncOutput {
    let mut passed = 0usize;
    let mut failed = 0usize;
    let mut skipped = 0usize;

    for line in output.lines().rev().take(20) {
        if let Some(p) = extract_count(line, "passed") {
            passed = p;
        }
        if let Some(f) = extract_count(line, "failed") {
            failed = f;
        }
        if let Some(s) = extract_count(line, "skipped") {
            skipped = s;
        }
        if passed > 0 || failed > 0 {
            break;
        }
    }

    let total = passed + failed + skipped;
    let summary = if total > 0 {
        format!("{} passed, {} failed, {} skipped", passed, failed, skipped)
    } else {
        let lines: Vec<&str> = output.lines().rev().take(5).collect();
        lines.into_iter().rev().collect::<Vec<_>>().join("\n")
    };

    TestSyncOutput {
        framework: framework.to_string(),
        command_run: command_run.to_string(),
        total,
        passed,
        failed,
        skipped,
        duration_ms,
        failed_tests: Vec::new(),
        summary,
    }
}

fn extract_count(line: &str, keyword: &str) -> Option<usize> {
    let lower = line.to_lowercase();
    let idx = lower.find(keyword)?;
    let before = &line[..idx];
    before
        .split_whitespace()
        .last()
        .and_then(|s| s.parse::<usize>().ok())
}
