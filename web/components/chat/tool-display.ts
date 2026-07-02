// Author: Harsha Gundala
// tool-display.ts — operator tool name → lucide icon + present/past-tense chat labels.

import {
  AudioLines, Braces, CalendarClock, CalendarDays, CalendarX, ChartColumn,
  CircleStop, Database, DatabaseZap, FileSpreadsheet, FileUp, Files,
  FlaskConical, Globe, Hammer, Hash, KeyRound, LayoutDashboard, Layers,
  Mail, MessageSquare, Music, PenLine, Phone, PhoneIncoming, PhoneOutgoing, Plug, Rocket, ScrollText,
  Search, Split, Table2, UserCog, Users, Workflow, Wrench,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

export type ToolDisplay = { icon: LucideIcon; running: string; done: string };

const REGISTRY: Record<string, ToolDisplay> = {
  render_surface:        { icon: LayoutDashboard, running: "Rendering a surface",       done: "Rendered a surface" },
  show_flow:             { icon: Workflow,        running: "Drawing the flow",          done: "Drew the flow" },
  query_data:            { icon: Database,        running: "Querying data",             done: "Queried data" },
  manage_table:          { icon: Table2,          running: "Updating a table",          done: "Updated a table" },
  search_logs:           { icon: ScrollText,      running: "Searching the logs",        done: "Searched the logs" },
  list_calls:            { icon: Phone,           running: "Listing calls",             done: "Listed calls" },
  get_call:              { icon: PhoneIncoming,   running: "Pulling up a call",         done: "Pulled up a call" },
  get_recording:         { icon: AudioLines,      running: "Fetching the recording",    done: "Fetched the recording" },
  list_agents:           { icon: Users,           running: "Listing agents",            done: "Listed agents" },
  update_agent:          { icon: UserCog,         running: "Updating the agent",        done: "Updated the agent" },
  create_tool:           { icon: Hammer,          running: "Building a tool",           done: "Built a tool" },
  test_tool:             { icon: FlaskConical,    running: "Testing the tool",          done: "Tested the tool" },
  list_tools:            { icon: Wrench,          running: "Listing tools",             done: "Listed tools" },
  set_env_var:           { icon: KeyRound,        running: "Storing a secret",          done: "Stored a secret" },
  list_env_vars:         { icon: KeyRound,        running: "Listing secrets",           done: "Listed secrets" },
  add_mcp_server:        { icon: Plug,            running: "Connecting a server",       done: "Connected a server" },
  schedule_call:         { icon: CalendarClock,   running: "Scheduling a call",         done: "Scheduled a call" },
  list_scheduled_calls:  { icon: CalendarDays,    running: "Listing scheduled calls",   done: "Listed scheduled calls" },
  cancel_scheduled_call: { icon: CalendarX,       running: "Canceling a scheduled call", done: "Canceled a scheduled call" },
  place_call:            { icon: PhoneOutgoing,   running: "Placing a call",            done: "Placed a call" },
  provision_phone_number:{ icon: Hash,            running: "Provisioning a number",     done: "Provisioned a number" },
  web_search:            { icon: Globe,           running: "Searching the web",         done: "Searched the web" },
  list_datasets:         { icon: Database,        running: "Listing datasets",          done: "Listed datasets" },
  create_dataset:        { icon: DatabaseZap,     running: "Creating a dataset",        done: "Created a dataset" },
  query_dataset:         { icon: Search,          running: "Querying a dataset",        done: "Queried a dataset" },
  write_dataset:         { icon: PenLine,         running: "Writing to a dataset",      done: "Wrote to a dataset" },
  create_experiment:     { icon: Split,           running: "Starting an experiment",    done: "Started an experiment" },
  stop_experiment:       { icon: CircleStop,      running: "Stopping the experiment",   done: "Stopped the experiment" },
  experiment_results:    { icon: ChartColumn,     running: "Reading the results",       done: "Read the results" },
  create_screen:         { icon: Layers,          running: "Creating a screen",         done: "Created a screen" },
  list_files:            { icon: Files,           running: "Listing files",             done: "Listed files" },
  parse_csv:             { icon: FileSpreadsheet, running: "Parsing the CSV",           done: "Parsed the CSV" },
  import_csv:            { icon: FileUp,          running: "Importing the CSV",         done: "Imported the CSV" },
  run_js:                { icon: Braces,          running: "Running code",              done: "Ran code" },
  set_hold_music:        { icon: Music,           running: "Setting the hold music",    done: "Set the hold music" },
  send_email:             { icon: Mail,            running: "Sending an email",          done: "Sent an email" },
  send_sms:               { icon: MessageSquare,   running: "Sending a text",            done: "Sent a text" },
  launch_task:            { icon: Rocket,          running: "Launching a background task", done: "Launched a background task" },
};

/** Resolve a tool name to its display; unknown names get a readable fallback. */
export function toolDisplay(name: string): ToolDisplay {
  const hit = REGISTRY[name];
  if (hit) return hit;
  const human = name.replace(/[_-]+/g, " ").trim() || "a tool";
  return { icon: Wrench, running: `Running ${human}`, done: `Ran ${human}` };
}
