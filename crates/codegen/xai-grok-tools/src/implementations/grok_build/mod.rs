//! New-architecture tool implementations (NewTool trait).
//!
//! Each sub-module here contains a tool that implements `NewTool` instead
//! of the old `Tool` trait. During migration, old implementations live in
//! `implementations/<tool>/` and new implementations live in
//! `implementations/grok_build/<tool>/`.
//!
//! The [`register_all()`] function is the single entry-point for wiring up
//! the standard toolset. It inserts shared resources (`Terminal`,
//! `AvailableSkills`, `BashParams`) and registers every built-in tool.
pub mod ask_user_question;
pub mod bash;
pub mod codegraph_explore;
pub mod computer_use;
#[path = "deploy_app_stub.rs"]
pub mod deploy_app;
pub mod enter_plan_mode;
pub mod exit_plan_mode;
pub mod grep;
pub mod image_edit;
pub mod image_gen;
pub mod kill_task;
pub mod list_dir;
pub mod lsp;
pub mod monitor;
pub mod notebook_edit;
pub mod read_file;
pub mod report_findings;
pub mod scheduler;
pub mod schedule_wakeup;
pub mod send_message;
pub mod search_replace;
pub mod sleep;
pub(crate) mod storage;
pub mod task;
pub mod task_output;
pub mod test_sync;
pub mod todo;
pub mod turn_rollback;
pub mod update_goal;
pub mod video_gen;
pub mod web_fetch;
pub mod web_search;
pub mod workflow;
pub use ask_user_question::AskUserQuestionTool;
pub use bash::BashTool;
pub use codegraph_explore::CodeGraphExploreTool;
pub use computer_use::ComputerUseTool;
pub use deploy_app::{AppBuilderDeployerConfig, DEPLOY_APP_TOOL_NAME};
pub use enter_plan_mode::EnterPlanModeTool;
pub use exit_plan_mode::ExitPlanModeTool;
pub use grep::GrepTool;
pub use image_edit::{IMAGE_EDIT_TOOL_NAME, ImageEditTool};
pub use image_gen::{
    IMAGE_GEN_TOOL_NAME, IMAGINE_COMMAND_NAME, ImageGenTool, imagine_instruction,
    imagine_usage_message,
};
pub use kill_task::{KillTaskTool, KillTerminalCommandTool};
pub use list_dir::ListDirTool;
pub use lsp::LspTool;
pub use monitor::tool::MonitorTool;
pub use notebook_edit::NotebookEditTool;
pub use read_file::ReadFileTool;
pub use report_findings::ReportFindingsTool;
pub use scheduler::create::{
    LoopFireMode, SCHEDULER_CREATE_TOOL_NAME, SchedulerCreateTool, loop_schedule_instruction,
    loop_usage_message,
};
pub use scheduler::delete::{SCHEDULER_DELETE_TOOL_NAME, SchedulerDeleteTool};
pub use scheduler::list::SchedulerListTool;
pub use schedule_wakeup::ScheduleWakeupTool;
pub use send_message::SendMessageTool;
pub use search_replace::SearchReplaceTool;
pub use task::{TaskTool, is_task_tool_id};
pub use task_output::{GetTerminalCommandOutputTool, TaskOutputTool, WaitTasksTool};
pub use todo::TodoWriteTool;
pub use turn_rollback::TurnRollbackTool;
pub use update_goal::{UPDATE_GOAL_TOOL_NAME, UpdateGoalTool};
pub use video_gen::{
    IMAGE_TO_VIDEO_TOOL_NAME, IMAGINE_VIDEO_COMMAND_NAME, ImageToVideoTool,
    REFERENCE_TO_VIDEO_TOOL_NAME, ReferenceToVideoTool, imagine_video_instruction,
    imagine_video_usage_message,
};
pub use web_fetch::{WebFetchClient, WebFetchConfig, WebFetchParams, WebFetchTool};
pub use sleep::SleepTool;
pub use test_sync::TestSyncTool;
pub use web_search::WebSearchTool;
pub use workflow::{WORKFLOW_TOOL_NAME, WorkflowTool};
