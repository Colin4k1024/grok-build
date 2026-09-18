//! `/evolution` -- open the evolution browser modal.
//!
//! Displays the 4-tab evolution view: Timeline, Lineage, Control, Evidence.

use crate::app::actions::Action;
use crate::slash::command::{CommandExecCtx, CommandResult, SlashCommand};

/// Open the evolution modal.
pub struct EvolutionCommand;

impl SlashCommand for EvolutionCommand {
    fn name(&self) -> &str {
        "evolution"
    }

    fn description(&self) -> &str {
        "View and manage experience evolution"
    }

    fn usage(&self) -> &str {
        "/evolution"
    }

    fn run(&self, _ctx: &mut CommandExecCtx, _args: &str) -> CommandResult {
        CommandResult::Action(Action::OpenEvolutionModal)
    }
}
