use std::path::Path;

#[derive(Debug, Clone)]
pub struct DetectedFramework {
    pub name: String,
    pub command: String,
}

pub fn detect_framework(cwd: &Path, filter: Option<&str>) -> Option<DetectedFramework> {
    if cwd.join("Cargo.toml").exists() {
        let mut cmd = "cargo test --format=json".to_string();
        if let Some(f) = filter {
            cmd.push(' ');
            cmd.push_str(f);
        }
        return Some(DetectedFramework {
            name: "cargo".to_string(),
            command: cmd,
        });
    }

    if let Some(fw) = detect_node_framework(cwd, filter) {
        return Some(fw);
    }

    if cwd.join("go.mod").exists() {
        let mut cmd = "go test -json ./...".to_string();
        if let Some(f) = filter {
            cmd = format!("go test -json -run '{}' ./...", f);
        }
        return Some(DetectedFramework {
            name: "go".to_string(),
            command: cmd,
        });
    }

    if cwd.join("pyproject.toml").exists()
        || cwd.join("pytest.ini").exists()
        || cwd.join("setup.cfg").exists()
    {
        let mut cmd = "python -m pytest -v --tb=short".to_string();
        if let Some(f) = filter {
            cmd.push_str(" -k ");
            cmd.push_str(f);
        }
        return Some(DetectedFramework {
            name: "pytest".to_string(),
            command: cmd,
        });
    }

    None
}

fn detect_node_framework(cwd: &Path, filter: Option<&str>) -> Option<DetectedFramework> {
    let pkg_path = cwd.join("package.json");
    if !pkg_path.exists() {
        return None;
    }

    let content = std::fs::read_to_string(&pkg_path).ok()?;
    let pkg: serde_json::Value = serde_json::from_str(&content).ok()?;

    let has_dep = |name: &str| -> bool {
        pkg.get("devDependencies")
            .and_then(|d| d.get(name))
            .is_some()
            || pkg.get("dependencies")
                .and_then(|d| d.get(name))
                .is_some()
    };

    if has_dep("vitest") {
        let mut cmd = "npx vitest run --reporter=json".to_string();
        if let Some(f) = filter {
            cmd.push_str(" --testNamePattern '");
            cmd.push_str(f);
            cmd.push('\'');
        }
        return Some(DetectedFramework {
            name: "vitest".to_string(),
            command: cmd,
        });
    }

    if has_dep("jest") {
        let mut cmd = "npx jest --json".to_string();
        if let Some(f) = filter {
            cmd.push_str(" --testNamePattern '");
            cmd.push_str(f);
            cmd.push('\'');
        }
        return Some(DetectedFramework {
            name: "jest".to_string(),
            command: cmd,
        });
    }

    None
}
