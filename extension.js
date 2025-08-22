"use strict";
const vscode = require("vscode");
const path = require("path");

// ---------------------------
// Header parsing
// ---------------------------
function detectRomInfo(doc) {
  const text = doc.getText(new vscode.Range(0, 0, Math.min(200, doc.lineCount), 0));
  // Rom ID: free text
  const mRom = text.match(/^\s*\*\s*Rom\s*ID:\s*([^\r\n]+)/mi);
  const romId = mRom ? mRom[1].trim() : undefined;
  // Game: DP | Diamond Pearl | Platinum | HGSS
  const mGame = text.match(/^\s*\*\s*Game:\s*(DP|Diamond\s*Pearl|Platinum|Plat|HGSS)\b/mi);
  let game;
  if (mGame && mGame[1]) {
    const val = mGame[1].toLowerCase().replace(/\s+/g, "");
    if (val.startsWith("hgss")) game = "hgss";
    else if (val.startsWith("plat")) game = "platinum";
    else if (val.startsWith("dp") || val.startsWith("diamondpearl")) game = "dp";
  }
  return { romId, game };
}

function mapGameToFilename(game) {
  if (game === "dp") return "diamond_pearl_scrcmd_database.json";
  if (game === "platinum") return "platinum_scrcmd_database.json";
  if (game === "hgss") return "hgss_scrcmd_database.json";
  return `${game}_scrcmd_database.json`;
}

function normalizeDB(raw) {
  if (!raw) return null;
  if (raw.scrcmd && typeof raw.scrcmd === "object") return raw.scrcmd;
  if (typeof raw === "object") return raw;
  return null;
}

// ---------------------------
async function readJsonUri(uri) {
  try {
    const data = await vscode.workspace.fs.readFile(uri);
    return JSON.parse(Buffer.from(data).toString("utf8"));
  } catch {
    return null;
  }
}

// Load DB with ROM-specific override first, then fallback to base game DB
async function loadDB(ctx, game, romId) {
  const appdata = process.env.APPDATA || process.env.HOME || ".";
  const baseDir = path.join(appdata, "DSPRE", "databases");

  // 1) edited_databases/<romId>_scrcmd_database.json
  if (romId) {
    const editedUri = vscode.Uri.file(path.join(baseDir, "edited_databases", `${romId}_scrcmd_database.json`));
    const edited = await readJsonUri(editedUri);
    if (edited) {
      const db = normalizeDB(edited);
      if (db) return db;
    }
  }
  // 2) <game>_scrcmd_database.json
  if (game) {
    const baseUri = vscode.Uri.file(path.join(baseDir, mapGameToFilename(game)));
    const base = await readJsonUri(baseUri);
    if (base) {
      const db = normalizeDB(base);
      if (db) return db;
    }
  }
  // 3) Nothing found
  return null;
}

// ---------------------------
// Hover (with opcode & icon) + number helpers
// ---------------------------
async function provideHover(doc, pos, ctx) {
  const wordRange = doc.getWordRangeAtPosition(
    pos,
    /(0x[0-9A-Fa-f]+|\b\d+\b|[A-Za-z_][A-Za-z0-9_#]*)/
  );
  const name = wordRange && doc.getText(wordRange);
  if (!name) return;
  const regHex = /^0x[a-fA-F0-9]+$/;
  const regDec = /^\d+$/;
  if (regHex.test(name)) return new vscode.Hover(`Decimal for ${name}: ${parseInt(name, 16)}`);
  if (regDec.test(name)) return new vscode.Hover(`Hex for ${name}: 0x${Number(name).toString(16).toUpperCase()}`);

  const { romId, game } = detectRomInfo(doc);
  const db = await loadDB(ctx, game, romId);
  if (!db) return;
  const entry = Object.entries(db).find(([_, c]) => (c.name || "").toLowerCase() === name.toLowerCase());
  if (!entry) return;
  const [opcodeKey, hit] = entry;

  let opcodeLabel = "";
  const n = Number(opcodeKey);
  if (!Number.isNaN(n)) opcodeLabel = ` \`0x${n.toString(16).toUpperCase()}\``;
  else if (/^0x/i.test(opcodeKey)) opcodeLabel = ` \`${String(opcodeKey).toUpperCase()}\``;
  else if (opcodeKey) opcodeLabel = ` \`${opcodeKey}\``;

  const params = Array.isArray(hit.parameter_values) ? hit.parameter_values : [];
  const header = `**$(symbol-function) ${hit.name}**${opcodeLabel}`;

  const md = new vscode.MarkdownString();
  md.supportThemeIcons = true;
  md.appendMarkdown(`${header}\n\n`);

  if (params.length) {
    md.appendMarkdown("**Parameters**\n\n");
    for (let i = 0; i < params.length; i++) md.appendMarkdown(`- ${params[i] ?? `arg${i+1}`}\n`);
    md.appendMarkdown("\n");
  }
  if (hit.description) md.appendMarkdown(`${hit.description}\n`);
  return new vscode.Hover(md, wordRange);
}

// ---------------------------
// Signature help (values only)
// ---------------------------
async function provideSignatureHelpClean(doc, pos, ctx) {
  const text = doc.lineAt(pos.line).text;
  const before = text.slice(0, pos.character);
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return null;
  const cmdName = tokens[0];
  const { romId, game } = detectRomInfo(doc);
  const db = await loadDB(ctx, game, romId);
  if (!db) return null;
  const hit = Object.values(db).find((c) => (c.name || "").toLowerCase() === cmdName.toLowerCase());
  if (!hit) return null;

  const params = Array.isArray(hit.parameter_values) ? hit.parameter_values : [];
  const sigLabel = `${hit.name} ${params.join(" ")}`.trim();
  const sig = new vscode.SignatureInformation(sigLabel, new vscode.MarkdownString(hit.description || ""));
  sig.parameters = params.map((p) => new vscode.ParameterInformation(p));

  const beforeTokens = before.trim().split(/\s+/).filter(Boolean);
  let activeParameter = Math.max(0, beforeTokens.length - 1);

  const sh = new vscode.SignatureHelp();
  sh.signatures = [sig];
  sh.activeSignature = 0;
  sh.activeParameter = Math.min(activeParameter, Math.max(0, params.length - 1));
  return sh;
}

// ---------------------------
// One-file navigation helpers
// ---------------------------
function parseRefAt(doc, pos) {
  const range = doc.getWordRangeAtPosition(pos, /(Function|Script|Action)#\d+/);
  if (!range) return undefined;
  const text = doc.getText(range);
  const m = text.match(/(Function|Script|Action)#(\d+)/);
  if (!m) return undefined;
  return { kind: m[1], id: parseInt(m[2], 10), range };
}

async function findInDoc(doc, kind, id) {
  const header = new RegExp(`^\\s*${kind}\\s+${id}:\\s*$`);
  for (let i = 0; i < doc.lineCount; i++) {
    if (header.test(doc.lineAt(i).text)) {
      return new vscode.Location(doc.uri, new vscode.Position(i, 0));
    }
  }
  return undefined;
}

// ---------------------------
// Activate
// ---------------------------
function activate(ctx) {
  const langSelectors = [
    { language: "pokemon_ds_script" },
    { language: "pokemon_ds_action" },
  ];

  // Completions (first token only)
  ctx.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      langSelectors,
      {
        async provideCompletionItems(doc, pos) {
          const line = doc.lineAt(pos.line).text;
          const before = line.slice(0, pos.character);
          const m = before.match(/^(\s*)(\S*)$/);
          if (!m) return;
          const firstWord = line.trimStart().split(/\s+/)[0] || "";
          if (!(m[2].length <= firstWord.length)) return;

          const { romId, game } = detectRomInfo(doc);
          const db = await loadDB(ctx, game, romId);
          if (!db) return;

          const style = vscode.workspace.getConfiguration("dspre").get("completions.style", "name-only");
          const items = [];
          for (const key of Object.keys(db)) {
            const cmd = db[key];
            const name = cmd.name || key;
            const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Function);
            item.insertText =
              style === "placeholders"
                ? new vscode.SnippetString(
                    `${name} ${((cmd.parameter_values || []).map((v, i) => `\${` + `{${i + 1}:${v}}` + `}`)).join(" ")}`.trim()
                  )
                : name + " ";
            item.command = { command: "editor.action.triggerParameterHints", title: "Trigger Parameter Hints" };
            items.push(item);
          }
          return items;
        }
      },
      " ", "\t"
    )
  );

  // Signature help
  ctx.subscriptions.push(
    vscode.languages.registerSignatureHelpProvider(
      langSelectors,
      { provideSignatureHelp(doc, pos) { return provideSignatureHelpClean(doc, pos, ctx); } },
      " ", ","
    )
  );

  // Hover
  ctx.subscriptions.push(
    vscode.languages.registerHoverProvider(langSelectors, {
      provideHover(doc, pos) { return provideHover(doc, pos, ctx); }
    })
  );

  // Definition (one-file only)
  ctx.subscriptions.push(
    vscode.languages.registerDefinitionProvider(langSelectors, {
      async provideDefinition(doc, pos) {
        const ref = parseRefAt(doc, pos);
        if (!ref) return;
        return await findInDoc(doc, ref.kind, ref.id);
      }
    })
  );

  // References + CodeLens (one-file only)
  const REF_TOKEN = /(Function|Script|Action)#(\d+)/;
  const HEADER = /^\s*(Script|Function|Action)\s+(\d+):\s*$/;

  async function findAllReferencesInDoc(doc, kind, id) {
    const locations = [];
    for (let i = 0; i < doc.lineCount; i++) {
      const line = doc.lineAt(i).text;
      const mHead = line.match(HEADER);
      if (mHead && mHead[1] === kind && parseInt(mHead[2], 10) === id) continue; // skip header
      const re = new RegExp(`\\b${kind}#${id}\\b`, "g");
      let m;
      while ((m = re.exec(line)) !== null) {
        const start = new vscode.Position(i, m.index);
        const end = new vscode.Position(i, m.index + m[0].length);
        locations.push(new vscode.Location(doc.uri, new vscode.Range(start, end)));
      }
    }
    return locations;
  }

  ctx.subscriptions.push(
    vscode.languages.registerReferenceProvider(langSelectors, {
      async provideReferences(doc, pos) {
        const range = doc.getWordRangeAtPosition(pos, REF_TOKEN);
        if (!range) return;
        const text = doc.getText(range);
        const m = text.match(REF_TOKEN);
        if (!m) return;
        return await findAllReferencesInDoc(doc, m[1], parseInt(m[2], 10));
      }
    })
  );

  class HeaderReferencesCodeLensProvider {
    provideCodeLenses(doc) {
      const lenses = [];
      for (let i = 0; i < doc.lineCount; i++) {
        const line = doc.lineAt(i).text;
        const m = line.match(HEADER);
        if (!m) continue;
        const range = new vscode.Range(new vscode.Position(i, 0), new vscode.Position(i, line.length));
        const lens = new vscode.CodeLens(range);
        lens.__dspre = { kind: m[1], id: parseInt(m[2], 10), uri: doc.uri };
        lenses.push(lens);
      }
      return lenses;
    }
    async resolveCodeLens(lens) {
      const meta = lens.__dspre;
      if (!meta) return lens;
      const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === meta.uri.toString());
      const refs = doc ? await findAllReferencesInDoc(doc, meta.kind, meta.id) : [];
      lens.command = {
        title: `${refs.length} reference${refs.length === 1 ? "" : "s"}`,
        command: "editor.action.showReferences",
        arguments: [ meta.uri, new vscode.Position(0, 0), refs ]
      };
      return lens;
    }
  }
  ctx.subscriptions.push(
    vscode.languages.registerCodeLensProvider(langSelectors, new HeaderReferencesCodeLensProvider())
  );

  // Outline (one-file structure)
  function dividerRegex() { return /^\s*\/\/+=====+\s*(SCRIPTS|FUNCTIONS|ACTIONS)\s*=====+\/\/+\s*$/i; }
  function headerRegex() { return /^\s*(Script|Function|Action)\s+(\d+):\s*$/; }
  function terminatorRegex() { return /^\s*(?:End|Return|Jump\b|UseScript#\d+)\b/; }

  function makeDocumentSymbols(doc) {
    const dividers = [];
    const headers = [];
    for (let i = 0; i < doc.lineCount; i++) {
      const line = doc.lineAt(i).text;
      const div = line.match(dividerRegex());
      if (div) { dividers.push({ name: div[1].toUpperCase(), line: i }); continue; }
      const head = line.match(headerRegex());
      if (head) headers.push({ kind: head[1], id: parseInt(head[2], 10), line: i });
    }

    const symbols = [];
    for (let d = 0; d < dividers.length; d++) {
      const sectionName = dividers[d].name;
      const sectionStart = new vscode.Position(dividers[d].line, 0);
      const sectionEndLine = d + 1 < dividers.length ? dividers[d + 1].line - 1 : doc.lineCount - 1;
      const sectionEnd = new vscode.Position(sectionEndLine, doc.lineAt(sectionEndLine).text.length);
      const sectionSymbol = new vscode.DocumentSymbol(
        sectionName, "", vscode.SymbolKind.Namespace,
        new vscode.Range(sectionStart, sectionEnd),
        new vscode.Range(sectionStart, sectionStart)
      );

      const children = headers
        .filter((h) => h.line > dividers[d].line && h.line <= sectionEndLine)
        .map((h) => {
          const start = new vscode.Position(h.line, 0);
          let endLine = sectionEndLine;
          for (let i = h.line + 1; i <= sectionEndLine; i++) {
            if (terminatorRegex().test(doc.lineAt(i).text)) { endLine = i; break; }
          }
          const end = new vscode.Position(endLine, doc.lineAt(endLine).text.length);
          const displayName = `[${h.kind[0]}] ${h.kind} ${h.id}`;
          const kindMap = { Script: vscode.SymbolKind.Module, Function: vscode.SymbolKind.Function, Action: vscode.SymbolKind.Event };
          return new vscode.DocumentSymbol(
            displayName, "", kindMap[h.kind],
            new vscode.Range(start, end),
            new vscode.Range(start, start)
          );
        });
      sectionSymbol.children = children;
      symbols.push(sectionSymbol);
    }
    return symbols;
  }

  ctx.subscriptions.push(
    vscode.languages.registerDocumentSymbolProvider(langSelectors, { provideDocumentSymbols(doc) { return makeDocumentSymbols(doc); } })
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
