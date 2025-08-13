/* eslint-disable */
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

// ---------------------------
// PERSISTENCE / STATE
// ---------------------------
let extensionContext; // defined in activate()

const STORAGE_KEYS = {
    FILES: 'jsonAuto.files',        // string[]: paths to JSON (absolute or relative to the extension)
    CURRENT: 'jsonAuto.currentFile' // string  : path to the selected JSON
};

// Built-in files (relative to the extension folder)
const BUILTIN_FILES = [
    'scrcmd-hgss.json',
    'scrcmd-plat.json',
    'scrcmd-dp.json'
];

// Currently selected file used for autocompletion / hover / panel
let currentFile = null;

let multipleFileOpening = true;

// Cache of entries in the unified format: { name, id, parameters, description, notes, type }[]
let entriesCache = null;

// ---------------------------
/** ACTIVATION */
// ---------------------------
function activate(context) {
    extensionContext = context;

    console.log('DSPRE Script Support activated');

    // Load the list of available JSON files + restore the last selected one
    let availableJsonFiles = readPersistedFiles();
    currentFile = readCurrentFile() || availableJsonFiles[0];
    persistCurrentFile(currentFile);
    loadEntries();
    updateStatusBar();

    // ---------------------------
    // Listeners and Providers
    // ---------------------------
    const fileOpenListener = vscode.workspace.onDidOpenTextDocument(async (document) => {
        if (!multipleFileOpening) return;

        const filePath = document.fileName;
        const fileName = path.basename(filePath);
        const match = fileName.match(/^(\d{4})_(script|action|func)\b/);

        if (match) {
            const prefix = match[1];
            await closeAllEditors();
            await openMatchingFilesSideBySide(prefix);
        }
    });

    const disposable = vscode.commands.registerCommand('dspre-script-support.helloWorld', function () {
        vscode.window.showInformationMessage('Hello World from DSPRE-Script-Support!');
    });

    const provider = vscode.languages.registerDocumentLinkProvider(
        { scheme: 'file', language: 'pokemon_ds_script' },
        {
            async provideDocumentLinks(document) {
                const links = [];
                const text = document.getText();
                const regex = /\b(Function#(\d+)|Script#(\d+)|Action#(\d+))\b/g;
                let match;

                while ((match = regex.exec(text)) !== null) {
                    const referencedNumber = match[2] || match[3] || match[4];
                    const refType = match[1];

                    const refFile = resolveFilePath(document.uri.fsPath, referencedNumber, refType);

                    if (refFile) {
                        const targetDocument = await vscode.workspace.openTextDocument(refFile);

                        const targetLabelRegex = new RegExp(`^\\s*${refType.replace('#', ' ')}:`, 'i');

                        let targetLine = null;

                        for (let line = 0; line < targetDocument.lineCount; line++) {
                            const lineText = targetDocument.lineAt(line).text;
                            if (targetLabelRegex.test(lineText)) {
                                targetLine = line;
                                break;
                            }
                        }

                        if (targetLine !== null) {
                            const startPosition = document.positionAt(match.index);
                            const endPosition = document.positionAt(match.index + match[0].length);

                            const link = new vscode.DocumentLink(
                                new vscode.Range(startPosition, endPosition),
                                vscode.Uri.file(refFile).with({ fragment: `L${targetLine + 1},0` })
                            );

                            link.tooltip = `Go to ${refType} in ${refFile}, line ${targetLine + 1}`;

                            links.push(link);
                        }
                    }
                }
                return links;
            }
        }
    );

    const hoverProvider = vscode.languages.registerHoverProvider(['pokemon_ds_script', 'pokemon_ds_action'], {
        provideHover(document, position) {
            if (!entriesCache) loadEntries();
            const wordRange = document.getWordRangeAtPosition(position, /\w+/);
            if (!wordRange) return;

            const word = document.getText(wordRange);
            const entry = entriesCache.find(e => e.name === word);

            if (entry) {
                let markdown = new vscode.MarkdownString();
                markdown.appendMarkdown(`🔹 **${entry.name}** [${entry.type}]\n`);
                markdown.appendMarkdown(`ID: \`${entry.id}\`\n`);

                if (entry.parameters && entry.parameters.length > 0) {
                    markdown.appendMarkdown(`\n**Parameters:**\n`);
                    entry.parameters.forEach(param => {
                        markdown.appendMarkdown(`- ${param}\n`);
                    });
                }

                if (entry.description) {
                    markdown.appendMarkdown(`\n---\n${entry.description}`);
                }

                markdown.supportHtml = false;
                markdown.isTrusted = true;
                return new vscode.Hover(markdown);
            } else {
                // Handles hexadecimal or decimal numbers
                const regHex = /^0x[a-fA-F0-9]+$/;
                const regDec = /^\d+$/;

                if (regHex.test(word)) {
                    return new vscode.Hover(`Decimal for ${word}: ${hexToDecimal(word)}`);
                } else if (regDec.test(word)) {
                    return new vscode.Hover(`Hex for ${word}: 0x${decimalToHex(word)}`);
                }
            }
        }
    });

    const symbol = vscode.languages.registerDocumentSymbolProvider(
        { scheme: 'file', languages: ['pokemon_ds_script', 'pokemon_ds_action'] },
        new PokemonDSScriptSymbolProvider()
    );

    // Toggle automatic multiple file opening
    let multipleFileOpeningCommand = vscode.commands.registerCommand('extension.multipleFileOpening', function () {
        multipleFileOpening = !multipleFileOpening;
        updateStatusBar();
    });

    // Open panel
    let openPanelCommand = vscode.commands.registerCommand('extension.openScrcmd', displayScrcmd);

    // Change theme
    const changeThemeCommand = vscode.commands.registerCommand('extension.changeTheme', async () => {
        const themeName = "Custom Script Theme";
        await vscode.workspace.getConfiguration().update(
            'workbench.colorTheme',
            themeName,
            vscode.ConfigurationTarget.Workspace
        );
        vscode.window.showInformationMessage(`Theme changed to ${themeName}`);
    });

    // Completion providers
    let scriptCompletionProvider = vscode.languages.registerCompletionItemProvider(
        'pokemon_ds_script',
        { provideCompletionItems },
        '.'
    );
    let actionCompletionProvider = vscode.languages.registerCompletionItemProvider(
        'pokemon_ds_action',
        { provideCompletionItems },
        '.'
    );

    // --------- JSON commands: change / add -----------
    // Replace the old changeFile command with a persistent version
    let changeFileCommand = vscode.commands.registerCommand('json-autocompletion.changeFile', async () => {
        const savedList = readPersistedFiles();

        const pick = await vscode.window.showQuickPick(
            savedList.map(f => ({
                label: path.basename(f),
                description: path.isAbsolute(f) ? f : `(builtin) ${f}`,
                value: f
            })),
            { placeHolder: 'Select the JSON file for autocompletion' }
        );

        if (pick) {
            currentFile = pick.value;
            await persistCurrentFile(currentFile);
            loadEntries();
            vscode.window.showInformationMessage(`Autocompletion file changed to ${path.basename(currentFile)}`);
            updateStatusBar();
        }
    });

    // Add a user JSON
    let addFileCommand = vscode.commands.registerCommand('json-autocompletion.addFile', async () => {
        const uris = await vscode.window.showOpenDialog({
            canSelectMany: false,
            openLabel: 'Add JSON for autocompletion',
            filters: { 'JSON': ['json'] }
        });

        if (!uris || uris.length === 0) return;
        const filePath = uris[0].fsPath;

        try {
            const data = loadJsonFile(filePath);
            const normalized = normalizeEntries(data);
            if (!Array.isArray(normalized) || normalized.length === 0) {
                const choice = await vscode.window.showWarningMessage(
                    'JSON loaded but produced no entries. Add anyway?',
                    'Yes', 'No'
                );
                if (choice !== 'Yes') return;
            }
        } catch (err) {
            vscode.window.showErrorMessage(`Failed to read JSON: ${err.message}`);
            return;
        }

        const list = readPersistedFiles();
        if (!list.includes(filePath)) {
            list.push(filePath);
            await persistFiles(list);
        }

        currentFile = filePath;
        await persistCurrentFile(currentFile);
        loadEntries();
        vscode.window.showInformationMessage(`Added and selected: ${filePath}`);
        updateStatusBar();
    });

    // Initial status bar (already called earlier for cold start display)
    updateStatusBar();

    // Subscriptions
    context.subscriptions.push(
        disposable,
        fileOpenListener,
        hoverProvider,
        provider,
        symbol,
        openPanelCommand,
        changeFileCommand,
        addFileCommand,
        scriptCompletionProvider,
        actionCompletionProvider,
        changeThemeCommand,
        multipleFileOpeningCommand
    );
}

// ---------------------------
/** WEBVIEW (Panel) */
// ---------------------------
function displayScrcmd() {
    if (!entriesCache) loadEntries();

    const panel = vscode.window.createWebviewPanel(
        'scrcmdPage',
        'scrcmd',
        vscode.ViewColumn.Active,
        {
            enableScripts: true,
        }
    );

    panel.webview.html = getWebviewContent(entriesCache);
}

function getWebviewContent(data) {
    const serializedData = JSON.stringify(data);
    return `
    <!DOCTYPE html>
    <html lang="fr">
    <head>
      <meta charset="UTF-8">
      <title>scrcmd</title>
      <style>
        body {
          font-family: sans-serif;
          padding: 1rem;
          background-color: #1e1e1e;
          color: white.
        }
        input#globalSearch {
          margin-bottom: 1rem;
          padding: 0.5rem;
          width: 100%;
          font-size: 1rem;
          background: #2e2e2e;
          border: 1px solid #555;
          color: white;
        }
        table {
          border-collapse: collapse;
          width: 100%;
          table-layout: fixed;
        }
        th, td {
          border: 1px solid #ccc;
          padding: 0.5rem;
          text-align: left;
          word-wrap: break-word;
        }
        tr:nth-child(even) {
          background-color: rgb(56, 56, 56);
        }
        th {
          background-color: rgb(56, 56, 56);
          cursor: pointer;
          user-select: none;
          position: sticky;
          top: 0;
          z-index: 2;
        }
        .small { width: 80px; }
        .medium { width: 160px; }
  
        th::after {
          content: ' ⬍';
          float: right;
        }
        th.sorted-asc::after {
          content: ' 🔼';
        }
        th.sorted-desc::after {
          content: ' 🔽';
        }
      </style>
    </head>
    <body>
      <input type="text" id="globalSearch" placeholder="Search in scrcmd...">
      <table>
        <thead>
          <tr>
            <th class="small" data-key="id">ID</th>
            <th class="medium" data-key="name">Name</th>
            <th data-key="parameters">Parameters</th>
            <th data-key="description">Description</th>
            <th data-key="notes">Notes</th>
            <th class="small" data-key="type">Type</th>
          </tr>
        </thead>
        <tbody id="tableBody"></tbody>
      </table>
  
      <script>
        const BATCH_SIZE = 50;
        let allData = ${serializedData};
        let filteredData = [...allData];
        let renderedCount = 0;
        let currentSort = { key: '', direction: '' };
        const tableBody = document.getElementById('tableBody');
        const globalSearch = document.getElementById('globalSearch');
  
        function renderBatch() {
          const end = Math.min(renderedCount + BATCH_SIZE, filteredData.length);
          for (let i = renderedCount; i < end; i++) {
            const item = filteredData[i];
            const row = document.createElement('tr');
            row.innerHTML = \`
              <td class="small">\${item.id}</td>
              <td>\${item.name}</td>
              <td>\${Array.isArray(item.parameters) ? item.parameters.join(', ') : (item.parameters ?? '')}</td>
              <td>\${item.description}</td>
              <td>\${item.notes ?? ''}</td>
              <td class="small">\${item.type}</td>
            \`;
            tableBody.appendChild(row);
          }
          renderedCount = end;
        }
  
        function refreshView() {
          renderedCount = 0;
          tableBody.innerHTML = '';
          renderBatch();
        }
  
        function applyGlobalSearch() {
          const filter = globalSearch.value.toLowerCase();
          filteredData = allData.filter(item =>
            Object.values(item).some(val =>
              String(val).toLowerCase().includes(filter)
            )
          );
          refreshView();
        }
  
        function isNearBottom() {
          return window.innerHeight + window.scrollY >= document.body.offsetHeight - 100;
        }
  
        function sortDataByKey(key) {
          if (currentSort.key === key) {
            currentSort.direction = currentSort.direction === 'asc' ? 'desc' : 'asc';
          } else {
            currentSort.key = key;
            currentSort.direction = 'asc';
          }
  
          filteredData.sort((a, b) => {
            const valA = a[key] ?? '';
            const valB = b[key] ?? '';
            if (typeof valA === 'number' && typeof valB === 'number') {
              return currentSort.direction === 'asc' ? valA - valB : valB - valA;
            } else {
              return currentSort.direction === 'asc'
                ? String(valA).localeCompare(String(valB))
                : String(valB).localeCompare(String(valA));
            }
          });
  
          refreshView();
        }
  
        window.addEventListener('scroll', () => {
          if (isNearBottom() && renderedCount < filteredData.length) {
            renderBatch();
          }
        });
  
        globalSearch.addEventListener('input', () => {
          applyGlobalSearch();
        });
  
        document.querySelectorAll('th[data-key]').forEach(th => {
          th.addEventListener('click', () => {
            const key = th.dataset.key;
            document.querySelectorAll('th').forEach(el => {
              el.classList.remove('sorted-asc', 'sorted-desc');
            });
  
            if (currentSort.key === key && currentSort.direction === 'asc') {
              th.classList.add('sorted-desc');
            } else {
              th.classList.add('sorted-asc');
            }
  
            sortDataByKey(key);
          });
        });
  
        refreshView();
      </script>
    </body>
    </html>
    `;
}

// ---------------------------
/** GLOBAL UTILS */
// ---------------------------
function hexToDecimal(hex) {
    return parseInt(hex, 16);
}

function decimalToHex(decimal) {
    return Number(decimal).toString(16).toUpperCase();
}

async function closeAllEditors() {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
}

async function openMatchingFilesSideBySide(prefix) {
    const workspaceFolders = vscode.workspace.workspaceFolders;

    if (!workspaceFolders) {
        vscode.window.showErrorMessage("No workspace folder open.");
        return;
    }

    const folderPath = workspaceFolders[0].uri.fsPath;
    const files = await findFilesWithPrefix(folderPath, prefix);

    if (files.length === 0) {
        vscode.window.showInformationMessage("No matching files found.");
        return;
    }

    files.sort((a, b) => {
        if (a.includes('_script')) return -1;
        if (b.includes('_script')) return 1;
        if (a.includes('_func')) return -1;
        if (b.includes('_func')) return 1;
        return 0;
    });

    let column = vscode.ViewColumn.One;
    for (const file of files) {
        const fileUri = vscode.Uri.file(file);
        await vscode.workspace.openTextDocument(fileUri).then(doc => {
            vscode.window.showTextDocument(doc, { viewColumn: column, preview: false });
        });

        column = column === vscode.ViewColumn.Three ? vscode.ViewColumn.One : column + 1;
    }
}

async function findFilesWithPrefix(dir, prefix) {
    const files = await fs.promises.readdir(dir, { withFileTypes: true });
    const matchingFiles = [];

    for (const file of files) {
        const filePath = path.join(dir, file.name);

        if (file.isDirectory()) {
            matchingFiles.push(...await findFilesWithPrefix(filePath, prefix));
        } else if (file.name.match(new RegExp(`^${prefix}_(script|action|func)\\b`))) {
            matchingFiles.push(filePath);
        }
    }

    return matchingFiles;
}

function resolveFilePath(currentFilePath, referencedNumber, refType) {
    const fileName = path.basename(currentFilePath);
    const baseNumber = fileName.split('_')[0];

    let refFile;
    refType = refType.split('#')[0];
    if (refType === 'Function') {
        refFile = `${baseNumber}_func.script`;
    } else if (refType === 'Script') {
        refFile = `${baseNumber}_script.script`;
    } else if (refType === 'Action') {
        refFile = `${baseNumber}_action.action`;
    } else {
        return null;
    }

    const workspaceFolders = vscode.workspace.workspaceFolders;
    const rootDir = workspaceFolders && workspaceFolders.length > 0
        ? workspaceFolders[0].uri.fsPath
        : vscode.workspace.rootPath || path.dirname(currentFilePath); // fallback

    const filePath = path.join(rootDir, refFile);
    if (fs.existsSync(filePath)) {
        return filePath;
    }
    return null;
}

// ---------------------------
/** STATUS BAR */
// ---------------------------
let statusBarItem;
let statusBarItem2;
let statusBarItem3;
let statusBarItem4; // current JSON
let statusBarItem5; // Add JSON

function updateStatusBar() {
    if (statusBarItem) {
        try { statusBarItem.dispose(); } catch {}
    }
    if (statusBarItem2) {
        try { statusBarItem2.dispose(); } catch {}
    }
    if (statusBarItem3) {
        try { statusBarItem3.dispose(); } catch {}
    }
    if (statusBarItem4) {
        try { statusBarItem4.dispose(); } catch {}
    }
    if (statusBarItem5) {
        try { statusBarItem5.dispose(); } catch {}
    }

    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.text = "Open scrcmd";
    statusBarItem.command = "extension.openScrcmd";
    statusBarItem.show();

    statusBarItem2 = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    statusBarItem2.text = "Pokemon DS Script Colors";
    statusBarItem2.command = "extension.changeTheme";
    statusBarItem2.show();

    statusBarItem3 = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
    statusBarItem3.text = multipleFileOpening ? 'Disable automatic file opening' : 'Enable automatic file opening';
    statusBarItem3.command = "extension.multipleFileOpening";
    statusBarItem3.show();

    statusBarItem4 = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 97);
    statusBarItem4.text = `JSON: ${currentFile ? path.basename(currentFile) : 'None'}`;
    statusBarItem4.tooltip = currentFile || '';
    statusBarItem4.command = 'json-autocompletion.changeFile';
    statusBarItem4.show();

    statusBarItem5 = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 96);
    statusBarItem5.text = 'Add JSON';
    statusBarItem5.command = 'json-autocompletion.addFile';
    statusBarItem5.show();
}

// ---------------------------
/** LOADING JSON (old/new format) */
// ---------------------------
function resolveJsonPath(candidate) {
    if (path.isAbsolute(candidate)) return candidate;
    return path.join(__dirname, candidate);
}

function loadJsonFile(jsonPath) {
    const realPath = resolveJsonPath(jsonPath);
    const raw = fs.readFileSync(realPath, 'utf8');
    return JSON.parse(raw);
}

/**
 * old format -> entries[]
 * old: { entries: [ { name, id, parameters, description, notes, type }, ... ] }
 * (already has movements, operators, directions, commands, etc.)  :contentReference[oaicite:2]{index=2}
 */
function normalizeOldFormat(obj) {
    const entries = Array.isArray(obj.entries) ? obj.entries : [];
    return entries;
}

/**
 * new format -> entries[]
 * new: {
 *   movements: { "0x..": { name, decomp_name, description } },
 *   comparisonOperators: { "0x..": "LESS" },
 *   overworldDirections: { "0x..": "Up" },
 *   specialOverworlds: { "0x..": "Player" },
 *   scrcmd: { "0x..": { name, parameter_values[], description, ... } }
 * }  :contentReference[oaicite:3]{index=3}
 */
function normalizeNewFormat(obj) {
    const out = [];

    // movements -> movement
    if (obj.movements && typeof obj.movements === 'object') {
        for (const [id, v] of Object.entries(obj.movements)) {
            out.push({
                name: v?.name ?? '',
                id,
                parameters: [],
                description: v?.description ?? '',
                notes: '',
                type: 'movement'
            });
        }
    }

    // comparisonOperators -> operator
    if (obj.comparisonOperators && typeof obj.comparisonOperators === 'object') {
        for (const [id, name] of Object.entries(obj.comparisonOperators)) {
            out.push({
                name: String(name ?? ''),
                id,
                parameters: [],
                description: '',
                notes: '',
                type: 'operator'
            });
        }
    }

    // overworldDirections -> direction
    if (obj.overworldDirections && typeof obj.overworldDirections === 'object') {
        for (const [id, name] of Object.entries(obj.overworldDirections)) {
            out.push({
                name: String(name ?? ''),
                id,
                parameters: [],
                description: '',
                notes: '',
                type: 'direction'
            });
        }
    }

    // specialOverworlds -> specialOverworld
    if (obj.specialOverworlds && typeof obj.specialOverworlds === 'object') {
        for (const [id, name] of Object.entries(obj.specialOverworlds)) {
            out.push({
                name: String(name ?? ''),
                id,
                parameters: [],
                description: '',
                notes: '',
                type: 'specialOverworld'
            });
        }
    }

    // scrcmd -> command (reprendre parameter_values si dispo)
    if (obj.scrcmd && typeof obj.scrcmd === 'object') {
        for (const [id, cmd] of Object.entries(obj.scrcmd)) {
            const params =
                Array.isArray(cmd?.parameter_values) ? cmd.parameter_values.map(String) :
                Array.isArray(cmd?.parameters) ? cmd.parameters.map(String) :
                [];

            out.push({
                name: cmd?.name ?? '',
                id,
                parameters: params,
                description: cmd?.description ?? '',
                notes: '',
                type: 'command'
            });
        }
    }

    return out;
}

/** Detect the format the return the entries[] */
function normalizeEntries(obj) {
    if (obj && typeof obj === 'object') {
        if (Array.isArray(obj.entries)) return normalizeOldFormat(obj);
        // new format (sections)
        if (
            obj.movements || obj.scrcmd ||
            obj.comparisonOperators || obj.overworldDirections || obj.specialOverworlds
        ) {
            return normalizeNewFormat(obj);
        }
    }
    return [];
}

function loadEntries() {
    if (!currentFile) {
        entriesCache = [];
        return;
    }

    try {
        const data = loadJsonFile(currentFile);
        entriesCache = normalizeEntries(data);
        if (!Array.isArray(entriesCache)) entriesCache = [];
    } catch (err) {
        vscode.window.showErrorMessage(`Failed to load ${currentFile}: ${err.message}`);
        entriesCache = [];
    }
}

// ---------------------------
/** AUTOCOMPLETE */
// ---------------------------
function getSuggestions(input) {
    if (!entriesCache) loadEntries();
    const suggestions = [];

    for (const entry of entriesCache) {
        if (entry.name && entry.name.toLowerCase().startsWith(input.toLowerCase())) {
            const item = new vscode.CompletionItem(entry.name, vscode.CompletionItemKind.Keyword);
            item.detail = `${entry.id} (${entry.type})`;
            if (entry.description) item.documentation = entry.description;
            suggestions.push(item);
        }
    }

    return suggestions;
}

function provideCompletionItems(document, position) {
    const range = document.getWordRangeAtPosition(position, /\w+/);
    const input = range ? document.getText(range) : '';
    return getSuggestions(input);
}

// ---------------------------
/** OUTLINE */
// ---------------------------
class PokemonDSScriptSymbolProvider {
    provideDocumentSymbols(document) {
        const symbols = [];
        const text = document.getText();
        const lines = text.split('\n');

        const scriptRegex = /^Script\s+(\d+):/i;
        const functionRegex = /^Function\s+(\d+):/i;
        const actionRegex = /^Action\s+(\d+):/i;

        for (let line = 0; line < lines.length; line++) {
            const lineText = lines[line];

            let match;
            if ((match = scriptRegex.exec(lineText))) {
                symbols.push(
                    new vscode.DocumentSymbol(
                        `Script ${match[1]}`,
                        'Script Section',
                        vscode.SymbolKind.Method,
                        new vscode.Range(line, 0, line, lineText.length),
                        new vscode.Range(line, 0, line, lineText.length)
                    )
                );
            } else if ((match = functionRegex.exec(lineText))) {
                symbols.push(
                    new vscode.DocumentSymbol(
                        `Function ${match[1]}`,
                        'Function Section',
                        vscode.SymbolKind.Function,
                        new vscode.Range(line, 0, line, lineText.length),
                        new vscode.Range(line, 0, line, lineText.length)
                    )
                );
            } else if ((match = actionRegex.exec(lineText))) {
                symbols.push(
                    new vscode.DocumentSymbol(
                        `Action ${match[1]}`,
                        'Action Section',
                        vscode.SymbolKind.Object,
                        new vscode.Range(line, 0, line, lineText.length),
                        new vscode.Range(line, 0, line, lineText.length)
                    )
                );
            }
        }
        return symbols;
    }
}

// ---------------------------
/** PERSISTENCE HELPERS */
// ---------------------------
function readPersistedFiles() {
    const saved = extensionContext.globalState.get(STORAGE_KEYS.FILES);
    if (Array.isArray(saved) && saved.length > 0) return saved;
    return [...BUILTIN_FILES];
}

function persistFiles(files) {
    return extensionContext.globalState.update(STORAGE_KEYS.FILES, files);
}

function readCurrentFile() {
    return extensionContext.globalState.get(STORAGE_KEYS.CURRENT);
}

function persistCurrentFile(file) {
    return extensionContext.globalState.update(STORAGE_KEYS.CURRENT, file);
}

// ---------------------------
/** DEACTIVATION */
// ---------------------------
function deactivate() { }

module.exports = {
    activate,
    deactivate
};
