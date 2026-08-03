//! One-shot self-wakeup backed by the authoritative scheduler actor.

use serde::{Deserialize, Serialize};

use crate::implementations::grok_build::scheduler::types::{
    ScheduledTask, SchedulerCommand, SchedulerHandle, scheduler_tool_error,
};
use crate::types::requirements::{Expr, ToolRequirement};
use crate::types::tool::{ToolKind, ToolNamespace};

const MIN_DELAY_SECS: u64 = 60;
const MAX_DELAY_SECS: u64 = 3600;

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct ScheduleWakeupInput {
    #[serde(default)]
    #[schemars(description = "Delay before waking, clamped to 60..=3600 seconds")]
    pub delay_seconds: Option<u64>,
    #[serde(default)]
    #[schemars(description = "Prompt to execute when the wakeup fires")]
    pub prompt: Option<String>,
    #[serde(default)]
    #[schemars(description = "Short reason used when prompt is omitted")]
    pub reason: Option<String>,
    #[serde(
        default,
        deserialize_with = "crate::types::schema::deserialize_lenient_option_bool"
    )]
    #[schemars(description = "Cancel an existing wakeup instead of creating one")]
    pub stop: Option<bool>,
    #[serde(default)]
    #[schemars(description = "Required with stop=true; id returned by a previous call")]
    pub task_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct ScheduleWakeupOutput {
    pub scheduled: bool,
    pub delay_seconds: u64,
    pub reason: String,
    pub stopped: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_fire_at: Option<String>,
}

impl xai_tool_runtime::ToolOutput for ScheduleWakeupOutput {}

#[derive(Debug, Default)]
pub struct ScheduleWakeupTool;

impl crate::types::tool_metadata::ToolMetadata for ScheduleWakeupTool {
    fn kind(&self) -> ToolKind {
        ToolKind::Other
    }

    fn tool_namespace(&self) -> ToolNamespace {
        ToolNamespace::GrokBuild
    }

    fn description_template(&self) -> &str {
        "Schedule exactly one future main-conversation wakeup through the session scheduler. \
         The returned task_id can be cancelled with stop=true. The wakeup is persisted with \
         scheduler state and removed before firing, so restore cannot create a duplicate fire."
    }

    fn emitted_notifications(&self) -> &'static [&'static str] {
        &[
            "ScheduledTaskCreated",
            "ScheduledTaskFired",
            "ScheduledTaskRemoved",
        ]
    }

    fn requires_expr(&self) -> Expr<ToolRequirement> {
        use crate::implementations::grok_build::scheduler::create::SchedulerCreateTool;
        use crate::types::tool_metadata::ToolMetadata as TM;
        Expr::Value(ToolRequirement::Tool {
            namespace: TM::tool_namespace(&SchedulerCreateTool).to_string(),
            id: xai_tool_runtime::Tool::id(&SchedulerCreateTool).to_string(),
            if_params: None,
        })
    }
}

impl xai_tool_runtime::Tool for ScheduleWakeupTool {
    type Args = ScheduleWakeupInput;
    type Output = ScheduleWakeupOutput;

    fn id(&self) -> xai_tool_protocol::ToolId {
        xai_tool_protocol::ToolId::new("schedule_wakeup").expect("valid tool id")
    }

    fn description(
        &self,
        _ctx: &xai_tool_runtime::ListToolsContext,
    ) -> xai_tool_types::ToolDescription {
        xai_tool_types::ToolDescription::new(
            "schedule_wakeup",
            crate::types::tool_metadata::ToolMetadata::sanitized_description_template(self),
        )
    }

    fn capabilities(&self) -> xai_tool_protocol::ToolCapabilities {
        xai_tool_protocol::ToolCapabilities {
            is_read_only: false,
            tool_scope: Some(xai_tool_protocol::ToolScope::Write),
            ..Default::default()
        }
    }

    async fn run(
        &self,
        ctx: xai_tool_runtime::ToolCallContext,
        input: ScheduleWakeupInput,
    ) -> Result<ScheduleWakeupOutput, xai_tool_runtime::ToolError> {
        let sender = {
            let resources = crate::types::tool_metadata::shared_resources(&ctx)?;
            let resources = resources.lock().await;
            resources.require::<SchedulerHandle>()?.0.clone()
        };

        if input.stop.unwrap_or(false) {
            if input.delay_seconds.is_some() || input.prompt.is_some() || input.reason.is_some() {
                return Err(xai_tool_runtime::ToolError::invalid_arguments(
                    "stop=true accepts only task_id",
                ));
            }
            let task_id = input
                .task_id
                .filter(|id| !id.trim().is_empty())
                .ok_or_else(|| {
                    xai_tool_runtime::ToolError::invalid_arguments(
                        "task_id is required when stop=true",
                    )
                })?;
            let (reply, response) = tokio::sync::oneshot::channel();
            sender
                .send(SchedulerCommand::Delete {
                    id: task_id.clone(),
                    reply,
                })
                .map_err(|_| actor_stopped())?;
            let removed = response
                .await
                .map_err(|_| actor_dropped_reply())?
                .map_err(scheduler_tool_error)?;
            if !removed {
                return Err(xai_tool_runtime::ToolError::custom(
                    "wakeup_not_found",
                    format!("no pending wakeup with task id '{task_id}'"),
                ));
            }
            return Ok(ScheduleWakeupOutput {
                scheduled: false,
                delay_seconds: 0,
                reason: "wakeup cancelled".into(),
                stopped: true,
                task_id: Some(task_id),
                next_fire_at: None,
            });
        }

        if input.task_id.is_some() {
            return Err(xai_tool_runtime::ToolError::invalid_arguments(
                "task_id is only valid with stop=true",
            ));
        }
        let delay_seconds = input
            .delay_seconds
            .unwrap_or(MIN_DELAY_SECS)
            .clamp(MIN_DELAY_SECS, MAX_DELAY_SECS);
        let reason = input
            .reason
            .unwrap_or_else(|| "resume pending work".to_owned());
        if reason.trim().is_empty() {
            return Err(xai_tool_runtime::ToolError::invalid_arguments(
                "reason must not be empty",
            ));
        }
        let prompt = input.prompt.unwrap_or_else(|| {
            format!("Resume the pending work. Wakeup reason: {}", reason.trim())
        });
        if prompt.trim().is_empty() {
            return Err(xai_tool_runtime::ToolError::invalid_arguments(
                "prompt must not be empty",
            ));
        }
        // Durable one-shots use the scheduler's occurrence journal. The actor
        // persists task removal before it emits the fire, preventing a restored
        // state from scheduling the same wakeup again.
        let mut task = ScheduledTask::new(delay_seconds, prompt, false, true);
        task.foreground = true;
        let (reply, response) = tokio::sync::oneshot::channel();
        sender
            .send(SchedulerCommand::Create { task, reply })
            .map_err(|_| actor_stopped())?;
        let created = response
            .await
            .map_err(|_| actor_dropped_reply())?
            .map_err(scheduler_tool_error)?;
        Ok(ScheduleWakeupOutput {
            scheduled: true,
            delay_seconds,
            reason,
            stopped: false,
            task_id: Some(created.id.clone()),
            next_fire_at: Some(created.next_fire_at().to_rfc3339()),
        })
    }
}

fn actor_stopped() -> xai_tool_runtime::ToolError {
    xai_tool_runtime::ToolError::custom("process_manager", "Scheduler actor stopped")
}

fn actor_dropped_reply() -> xai_tool_runtime::ToolError {
    xai_tool_runtime::ToolError::custom("process_manager", "Scheduler actor dropped reply")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::implementations::grok_build::scheduler::actor::SchedulerActor;
    use crate::implementations::grok_build::scheduler::types::SchedulerState;
    use crate::notification::types::ToolNotificationHandle;
    use crate::types::resources::{Resources, SharedResources, State};
    use crate::types::tool_metadata::test_ctx;
    use xai_tool_runtime::Tool;

    fn scheduler_resources() -> (SharedResources, tokio_util::sync::CancellationToken) {
        let mut resources = Resources::new();
        resources.register_state::<SchedulerState>();
        let (command_tx, command_rx) = tokio::sync::mpsc::unbounded_channel();
        resources.insert(SchedulerHandle(command_tx));
        let resources = resources.into_shared();
        let (notification_handle, mut notifications) =
            ToolNotificationHandle::acknowledged_channel();
        tokio::spawn(async move {
            while let Some(delivery) = notifications.recv().await {
                if let Some(acknowledgement) = delivery.acknowledgement {
                    let _ = acknowledgement.send(Ok(()));
                }
            }
        });
        let cancel = tokio_util::sync::CancellationToken::new();
        tokio::spawn(
            SchedulerActor {
                resources: resources.clone(),
                resources_persistence: std::sync::Arc::new(
                    crate::persistence::ResourcesPersistence::noop(),
                ),
                notification_handle,
                cmd_rx: command_rx,
                cancel_token: cancel.clone(),
                clock: Default::default(),
                pending_removal: None,
                blocked_expiries: Default::default(),
            }
            .run(),
        );
        (resources, cancel)
    }

    #[test]
    fn schema_input_defaults_to_minimum_delay() {
        let input: ScheduleWakeupInput = serde_json::from_value(serde_json::json!({})).unwrap();
        assert_eq!(
            input.delay_seconds.unwrap_or(MIN_DELAY_SECS),
            MIN_DELAY_SECS
        );
    }

    #[test]
    fn delay_is_clamped_at_both_bounds() {
        assert_eq!(1_u64.clamp(MIN_DELAY_SECS, MAX_DELAY_SECS), MIN_DELAY_SECS);
        assert_eq!(
            10_000_u64.clamp(MIN_DELAY_SECS, MAX_DELAY_SECS),
            MAX_DELAY_SECS
        );
    }

    #[tokio::test]
    async fn creates_one_shot_foreground_task_and_can_cancel_it() {
        let (resources, cancel) = scheduler_resources();
        let created = ScheduleWakeupTool
            .run(
                test_ctx(resources.clone()),
                ScheduleWakeupInput {
                    delay_seconds: Some(1),
                    prompt: Some("resume work".into()),
                    reason: Some("dependency ready".into()),
                    stop: None,
                    task_id: None,
                },
            )
            .await
            .expect("wakeup creation succeeds");
        assert_eq!(created.delay_seconds, MIN_DELAY_SECS);
        let task_id = created.task_id.clone().expect("created task id");
        {
            let resources = resources.lock().await;
            let task = resources
                .require::<State<SchedulerState>>()
                .unwrap()
                .tasks
                .iter()
                .find(|task| task.id == task_id)
                .expect("wakeup retained by scheduler");
            assert!(!task.recurring);
            assert!(task.durable);
            assert!(task.foreground);
            assert_eq!(task.prompt, "resume work");
        }

        let stopped = ScheduleWakeupTool
            .run(
                test_ctx(resources.clone()),
                ScheduleWakeupInput {
                    delay_seconds: None,
                    prompt: None,
                    reason: None,
                    stop: Some(true),
                    task_id: Some(task_id),
                },
            )
            .await
            .expect("wakeup cancellation succeeds");
        assert!(stopped.stopped);
        let resources = resources.lock().await;
        assert!(
            resources
                .require::<State<SchedulerState>>()
                .unwrap()
                .tasks
                .is_empty()
        );
        cancel.cancel();
    }

    #[tokio::test]
    async fn fired_wakeup_is_removed_and_clears_its_occurrence_receipt() {
        let (resources, cancel) = scheduler_resources();
        let created = ScheduleWakeupTool
            .run(
                test_ctx(resources.clone()),
                ScheduleWakeupInput {
                    delay_seconds: Some(MIN_DELAY_SECS),
                    prompt: Some("resume once".into()),
                    reason: None,
                    stop: None,
                    task_id: None,
                },
            )
            .await
            .unwrap();
        let task_id = created.task_id.unwrap();
        {
            let mut resources = resources.lock().await;
            let task = resources
                .get_mut::<State<SchedulerState>>()
                .unwrap()
                .tasks
                .iter_mut()
                .find(|task| task.id == task_id)
                .unwrap();
            task.created_at = chrono::Utc::now() - chrono::Duration::seconds(MIN_DELAY_SECS as i64);
        }

        // Wake the actor's command branch so it recomputes its deadline from
        // the deliberately-due task.
        let sender = {
            let resources = resources.lock().await;
            resources.require::<SchedulerHandle>().unwrap().0.clone()
        };
        let (reply, response) = tokio::sync::oneshot::channel();
        sender.send(SchedulerCommand::List { reply }).unwrap();
        let _ = response.await.unwrap();
        for _ in 0..100 {
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            let empty = {
                let resources = resources.lock().await;
                resources
                    .require::<State<SchedulerState>>()
                    .unwrap()
                    .tasks
                    .is_empty()
            };
            if empty {
                break;
            }
        }

        let resources = resources.lock().await;
        let state = resources.require::<State<SchedulerState>>().unwrap();
        assert!(state.tasks.is_empty(), "one-shot task must be removed");
        let serialized = serde_json::to_value(&**state).unwrap();
        assert!(
            serialized.get("occurrenceJournal").is_none(),
            "successful fire must clear its persisted suppression receipt"
        );
        cancel.cancel();
    }
}
