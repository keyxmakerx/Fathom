//! `/mcp`: the Model Context Protocol over Streamable HTTP, for an AI app signed in as a
//! connector (ADR-0072 decisions 13 to 20).
//!
//! The token is checked first, on every request, by `oauth::Connector::verify_bearer`;
//! this file only reads the JSON-RPC message and runs one of five tools, each of which is
//! a `/ai/v1/*` route under another name, through the same `ai::open` and the same rules:
//!
//! - `whoami`, `list_designs`, `read_design`, `list_recommendations`: reads;
//! - `recommend`: the one write, an idea a person accepts or dismisses in Fathom.
//!
//! What the transport needs (MCP "Transports", 2025-11-25, read 2026-10-25):
//!
//! - one JSON-RPC message per POST; a batch is refused (batching left the protocol in
//!   2025-06-18);
//! - a notification or a response is answered `202` with no body;
//! - a request is answered with one `application/json` body; this server never opens a
//!   stream, so `GET` is `405`;
//! - an `Origin` that is not this server's is `403` (DNS rebinding);
//! - an `MCP-Protocol-Version` header this server does not speak is `400`.
//!
//! No session id is issued: every request carries its token and stands on its own.

use std::collections::BTreeMap;

use fathom_canon::Json;

use crate::ai::{self, AiError, VerifiedAi};
use crate::ai_api::AiApiState;
use crate::designs::DesignError;
use crate::grants::{Authority, AuthorityError};
use crate::oauth::PROTOCOL_VERSIONS;
use crate::repo::DesignId;

/// JSON-RPC error codes (JSON-RPC 2.0 section 5.1).
const PARSE_ERROR: i64 = -32700;
const INVALID_REQUEST: i64 = -32600;
const METHOD_NOT_FOUND: i64 = -32601;
const INVALID_PARAMS: i64 = -32602;
const INTERNAL_ERROR: i64 = -32603;

/// What the app is told at `initialize`, for its model to read.
const INSTRUCTIONS: &str = "Fathom holds network designs. This connection reads the designs \
    in one organisation that the person who signed in chose, with only the detail they \
    allowed: layout, and if allowed addresses and notes. Layout includes each device's \
    cards (Card, seated by HasCard; its ports say OnCard), power supplies, and the optic in a \
    port (the port's transceiver). Passwords, device secrets, serial numbers and the vault are \
    never part of a reading. You cannot change a design. You can recommend a \
    change with the recommend tool; a person sees it in Fathom, marked as an AI idea, and \
    accepts or dismisses it, on a computer or a phone. If someone gives you a Fathom label's \
    link (`.../scan#<design>/<id>`), the part after `#` is a design id and an id inside that \
    design. Start with list_designs, then read_design.";

/// The five tools, as `tools/list` gives them. Plain JSON so it reads as the protocol does;
/// a test checks it parses and names exactly the tools [`call`] runs.
const TOOLS: &str = r#"[
  {
    "name": "whoami",
    "title": "Who this connection is",
    "description": "The organisation this connection reads, whose sign-in it is, what it may see, which folders, whether it may recommend, and when it ends.",
    "inputSchema": {"type": "object", "properties": {}, "additionalProperties": false},
    "annotations": {"readOnlyHint": true, "openWorldHint": false}
  },
  {
    "name": "list_designs",
    "title": "List designs",
    "description": "The designs this connection may read, with their ids, names and where each sits: its site, building and closet, with each place's kind and role (a hub is the site others hang from). Give folder to list only the designs in one site, building or closet. Use an id with read_design.",
    "inputSchema": {
      "type": "object",
      "properties": {"folder": {"type": "string", "description": "A site, building or closet id from a design's where; only designs inside it."}},
      "additionalProperties": false
    },
    "annotations": {"readOnlyHint": true, "openWorldHint": false}
  },
  {
    "name": "read_design",
    "title": "Read a design",
    "description": "One design: where it sits (site, building, closet, with kind and hub role), its devices, links, sites and racks, the cards, power supplies and optics fitted in each device, and the spares on hand (stores, each spare's sort, model, state and count, and the fewest of a model kept), with addresses and notes only where the person allowed them. With notes allowed, a spare's custom fields such as its price and supplier, named in field_names. Never passwords, device secrets or serial numbers.",
    "inputSchema": {
      "type": "object",
      "properties": {"design": {"type": "string", "description": "The design's id, from list_designs."}},
      "required": ["design"],
      "additionalProperties": false
    },
    "annotations": {"readOnlyHint": true, "openWorldHint": false}
  },
  {
    "name": "list_recommendations",
    "title": "List my recommendations",
    "description": "What this connection has recommended on one design, and whether each was accepted, dismissed or is still waiting.",
    "inputSchema": {
      "type": "object",
      "properties": {"design": {"type": "string", "description": "The design's id."}},
      "required": ["design"],
      "additionalProperties": false
    },
    "annotations": {"readOnlyHint": true, "openWorldHint": false}
  },
  {
    "name": "recommend",
    "title": "Recommend a change",
    "description": "Recommend a change to one design. Nothing in the design changes: a person sees the idea in Fathom, marked as an AI idea, and accepts or dismisses it. An idea may add a room, a rack or a link between buildings as plain steps. Name devices, cards, ports, links, stores and spares in targets by the ids read_design gave; a stock idea (keep more of a model, order one, send one for repair) targets the store or spare it is about. Do not put passwords, keys or secrets in any text; text that looks like one is refused.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "design": {"type": "string", "description": "The design's id."},
        "title": {"type": "string", "description": "One line, up to 120 characters."},
        "why": {"type": "string", "description": "Why, in plain words, up to 1000 characters."},
        "steps": {
          "type": "array",
          "minItems": 1,
          "maxItems": 20,
          "items": {
            "type": "object",
            "properties": {
              "action": {"type": "string", "enum": ["add", "change", "remove", "connect", "move", "label"]},
              "target": {"type": "string", "description": "The id of the device, card, port, link, site, rack, store or spare the step is about, if any."},
              "text": {"type": "string", "description": "What to do, up to 300 characters."}
            },
            "required": ["action", "text"],
            "additionalProperties": false
          }
        }
      },
      "required": ["design", "title", "steps"],
      "additionalProperties": false
    },
    "annotations": {"readOnlyHint": false, "destructiveHint": false, "idempotentHint": false, "openWorldHint": false}
  }
]"#;

/// The tool names [`call`] runs, in [`TOOLS`] order.
pub const TOOL_NAMES: [&str; 5] = [
    "whoami",
    "list_designs",
    "read_design",
    "list_recommendations",
    "recommend",
];

/// What `/mcp` answers: a status and, unless `202`, a JSON body.
pub enum Answer {
    /// A notification or a response from the app.
    Accepted,
    /// A JSON-RPC response, `200`.
    Reply(Json),
    /// A message that is not one, `400` with a JSON-RPC error.
    Bad(Json),
}

fn obj(fields: Vec<(&str, Json)>) -> Json {
    Json::Obj(
        fields
            .into_iter()
            .map(|(k, v)| (k.to_string(), v))
            .collect(),
    )
}

fn result(id: Json, value: Json) -> Json {
    obj(vec![
        ("jsonrpc", Json::Str("2.0".into())),
        ("id", id),
        ("result", value),
    ])
}

fn error(id: Json, code: i64, message: &str) -> Json {
    obj(vec![
        ("jsonrpc", Json::Str("2.0".into())),
        ("id", id),
        (
            "error",
            obj(vec![
                ("code", Json::Int(code)),
                ("message", Json::Str(message.into())),
            ]),
        ),
    ])
}

/// The protocol version to answer `initialize` with: the app's when this server speaks it,
/// otherwise this server's newest, and the app decides (MCP "Lifecycle").
pub fn negotiate(asked: Option<&str>) -> &'static str {
    PROTOCOL_VERSIONS
        .iter()
        .find(|v| Some(**v) == asked)
        .copied()
        .unwrap_or(PROTOCOL_VERSIONS[0])
}

/// The tool list, parsed.
pub fn tools() -> Json {
    crate::json_in::parse(TOOLS.as_bytes()).unwrap_or(Json::Arr(Vec::new()))
}

/// Read one message and answer it. `verified` is the bearer token's, already checked.
pub async fn handle(state: &AiApiState, verified: &VerifiedAi, body: &[u8]) -> Answer {
    let message = match crate::json_in::parse(body) {
        Ok(m) => m,
        Err(_) => return Answer::Bad(error(Json::Null, PARSE_ERROR, "not JSON")),
    };
    let Json::Obj(mut m) = message else {
        return Answer::Bad(error(
            Json::Null,
            INVALID_REQUEST,
            "one JSON-RPC message per request; batches are not accepted",
        ));
    };
    if m.get("jsonrpc") != Some(&Json::Str("2.0".into())) {
        return Answer::Bad(error(Json::Null, INVALID_REQUEST, "not JSON-RPC 2.0"));
    }
    let method = match m.remove("method") {
        Some(Json::Str(s)) => s,
        // A response to something this server asked: it asks nothing, so nothing to do.
        None if m.contains_key("result") || m.contains_key("error") => return Answer::Accepted,
        _ => return Answer::Bad(error(Json::Null, INVALID_REQUEST, "no method")),
    };
    let id = match m.remove("id") {
        None => return Answer::Accepted,
        Some(id @ (Json::Str(_) | Json::Int(_))) => id,
        Some(_) => {
            return Answer::Bad(error(
                Json::Null,
                INVALID_REQUEST,
                "an id is a string or a whole number",
            ))
        }
    };
    let params = match m.remove("params") {
        None | Some(Json::Null) => BTreeMap::new(),
        Some(Json::Obj(p)) => p,
        Some(_) => return Answer::Reply(error(id, INVALID_PARAMS, "params is an object")),
    };
    Answer::Reply(match method.as_str() {
        "initialize" => {
            let asked = match params.get("protocolVersion") {
                Some(Json::Str(v)) => Some(v.as_str()),
                _ => None,
            };
            result(
                id,
                obj(vec![
                    ("protocolVersion", Json::Str(negotiate(asked).into())),
                    (
                        "capabilities",
                        obj(vec![(
                            "tools",
                            obj(vec![("listChanged", Json::Bool(false))]),
                        )]),
                    ),
                    (
                        "serverInfo",
                        obj(vec![
                            ("name", Json::Str("fathom".into())),
                            ("title", Json::Str("Fathom".into())),
                            ("version", Json::Str(env!("CARGO_PKG_VERSION").into())),
                        ]),
                    ),
                    ("instructions", Json::Str(INSTRUCTIONS.into())),
                ]),
            )
        }
        "ping" => result(id, Json::Obj(BTreeMap::new())),
        "tools/list" => result(id, obj(vec![("tools", tools())])),
        "tools/call" => {
            let name = match params.get("name") {
                Some(Json::Str(n)) if TOOL_NAMES.contains(&n.as_str()) => n.clone(),
                _ => return Answer::Reply(error(id, INVALID_PARAMS, "no such tool")),
            };
            let args = match params.get("arguments") {
                None | Some(Json::Null) => BTreeMap::new(),
                Some(Json::Obj(a)) => a.clone(),
                Some(_) => {
                    return Answer::Reply(error(id, INVALID_PARAMS, "arguments is an object"))
                }
            };
            match call(state, verified, &name, args).await {
                Ok(value) => result(id, tool_result(value, false)),
                Err(e) => match tool_error_text(&e) {
                    Some(text) => result(id, tool_result(Json::Str(text), true)),
                    None => {
                        tracing::error!(reason = %e, tool = %name, "an AI tool call failed");
                        error(id, INTERNAL_ERROR, "refused")
                    }
                },
            }
        }
        _ => error(id, METHOD_NOT_FOUND, "this server has tools only"),
    })
}

/// A tool's answer: the JSON as text for any app, and as structured content for an app
/// that reads it (MCP "Tools", 2025-06-18 and later). An error is text only.
fn tool_result(value: Json, is_error: bool) -> Json {
    let text = match &value {
        Json::Str(s) if is_error => s.clone(),
        other => String::from_utf8_lossy(&other.to_canonical_bytes()).into_owned(),
    };
    let mut fields = vec![
        (
            "content",
            Json::Arr(vec![obj(vec![
                ("type", Json::Str("text".into())),
                ("text", Json::Str(text)),
            ])]),
        ),
        ("isError", Json::Bool(is_error)),
    ];
    // structuredContent is an object; a list is wrapped so it is one.
    if !is_error {
        let structured = match value {
            Json::Obj(_) => value,
            other => obj(vec![("items", other)]),
        };
        fields.push(("structuredContent", structured));
    }
    obj(fields)
}

/// The sentence an app's model reads when a tool is refused, or `None` for a fault on this
/// side, which is logged and answered as a JSON-RPC internal error.
fn tool_error_text(e: &AiError) -> Option<String> {
    Some(match e {
        AiError::Refused => {
            "refused: this sign-in no longer stands; sign in to Fathom again".into()
        }
        AiError::SiteOff => "AI access is turned off on this server".into(),
        AiError::OrganisationOff => {
            "AI access, or this app, is turned off for this person in this organisation".into()
        }
        AiError::Limited => "this connection is limited to 60 requests a minute".into(),
        AiError::NotAllowed(why) | AiError::Malformed(why) => (*why).into(),
        AiError::NotFound | AiError::Design(DesignError::NoSuchDesign) => {
            "not found, or not inside what this connection may read".into()
        }
        AiError::Conflict { .. } => "that changed while it was being read; try again".into(),
        AiError::LooksSecret => "that looks as if it carries a password or key, so it was not \
            taken; reword it without the value"
            .into(),
        AiError::Authority(AuthorityError::NotAuthorised)
        | AiError::Authority(AuthorityError::QuorumNotMet { .. }) => {
            "the person who signed in does not have the permission this needs".into()
        }
        _ => return None,
    })
}

fn design_arg(args: &mut BTreeMap<String, Json>) -> Result<DesignId, AiError> {
    match args.remove("design") {
        Some(Json::Str(d)) => d.trim().parse().map_err(|_| AiError::NotFound),
        _ => Err(AiError::Malformed(
            "design is required: an id from list_designs",
        )),
    }
}

/// Run one tool as the matching `/ai/v1/*` route does.
async fn call(
    state: &AiApiState,
    verified: &VerifiedAi,
    name: &str,
    mut args: BTreeMap<String, Json>,
) -> Result<Json, AiError> {
    // ADR-0074 §8: list_designs may name a folder; one the key does not reach matches nothing.
    let mut within = None;
    if name == "list_designs" {
        match args.remove("folder") {
            None => {}
            Some(Json::Str(f)) => {
                within = Some(f.trim().parse().map_err(|_| AiError::NotFound)?);
            }
            Some(_) => return Err(AiError::Malformed("folder is an id from a design's where")),
        }
    }
    let design = match name {
        "whoami" | "list_designs" => {
            if !args.is_empty() {
                return Err(AiError::Malformed("this tool takes no other arguments"));
            }
            None
        }
        _ => Some(design_arg(&mut args)?),
    };
    if name != "recommend" && !args.is_empty() {
        return Err(AiError::Malformed("this tool takes only a design"));
    }
    let mut client = state.pool.get().await?;
    let tx = client.transaction().await?;
    let session = ai::open(&tx, &state.ring, verified).await?;
    let auth = Authority {
        ring: &state.ring,
        ctx: &session.ctx,
        tenant_key: &session.tenant_key,
        watch: &state.watch,
    };
    let answer = match (name, design) {
        ("whoami", _) => ai::whoami(&session),
        ("list_designs", _) => ai::ai_designs(&tx, &auth, &session.key, within).await?,
        ("read_design", Some(d)) => {
            ai::ai_reading(&tx, &auth, Some(&state.live.heads), &session, d).await?
        }
        ("list_recommendations", Some(d)) => Json::Arr(
            ai::ai_own_ideas(&tx, &auth, &session, d)
                .await?
                .iter()
                .map(ai::Idea::to_json)
                .collect(),
        ),
        ("recommend", Some(d)) => {
            // The rest of the arguments are the idea, in the shape `/ai/v1` takes, and
            // `ai::clean_idea` refuses anything else in them.
            let body = Json::Obj(args).to_canonical_bytes();
            ai::recommend(&tx, &auth, &session, d, &body)
                .await?
                .to_json()
        }
        _ => return Err(AiError::Malformed("no such tool")),
    };
    tx.commit().await?;
    Ok(answer)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_tool_list_parses_and_names_what_call_runs() {
        let Json::Arr(tools) = crate::json_in::parse(TOOLS.as_bytes()).unwrap() else {
            panic!("not a list");
        };
        let names: Vec<String> = tools
            .iter()
            .map(|t| match t {
                Json::Obj(m) => match &m["name"] {
                    Json::Str(s) => s.clone(),
                    _ => panic!("a name is a string"),
                },
                _ => panic!("a tool is an object"),
            })
            .collect();
        assert_eq!(names, TOOL_NAMES);
        // Only `recommend` writes, and it says so.
        for t in &tools {
            let Json::Obj(m) = t else { unreachable!() };
            let Json::Obj(a) = &m["annotations"] else {
                panic!("annotations")
            };
            let writes = m["name"] == Json::Str("recommend".into());
            assert_eq!(a["readOnlyHint"], Json::Bool(!writes));
        }
    }

    #[test]
    fn a_version_this_server_speaks_is_kept_and_any_other_gets_the_newest() {
        assert_eq!(negotiate(Some("2025-06-18")), "2025-06-18");
        assert_eq!(negotiate(Some("2024-11-05")), PROTOCOL_VERSIONS[0]);
        assert_eq!(negotiate(None), PROTOCOL_VERSIONS[0]);
    }

    #[test]
    fn the_instructions_promise_nothing_the_project_forbids() {
        let lower = INSTRUCTIONS.to_lowercase();
        for forbidden in [
            "zero-knowledge",
            "end-to-end",
            "cannot read your data",
            "only you hold the key",
        ] {
            assert!(!lower.contains(forbidden));
        }
    }
}
