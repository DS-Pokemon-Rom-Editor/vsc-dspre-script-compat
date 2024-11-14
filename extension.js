const vscode = require('vscode');
const fs = require('fs');
const path = require('path');


let currentFile = 'scrcmd-hgss.json'; // Default file


function activate(context) {

	console.log('DSPRE Script Support activated');


	const fileOpenListener = vscode.workspace.onDidOpenTextDocument(async (document) => {
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
                                    vscode.Uri.file(refFile).with({fragment: `L${targetLine+1},0`})
                                );
                        
                                link.tooltip = `Go to ${refType} in ${refFile}, line ${targetLine+1}`;
        
                                links.push(link);
                            }
                        }
                    }
                    return links;
                }
            }
    );

        const hoverProvider = vscode.languages.registerHoverProvider('pokemon_ds_script', {
            provideHover(document, position) {
        
                const numberRange = document.getWordRangeAtPosition(position, /\b(?:0x[0-9A-Fa-f]+|\d+(\.\d+)?)\b/)
                if (!numberRange) return;

                const number = document.getText(numberRange);


                if(number) {
                    const regHex = new RegExp(/0x[a-fA-F0-9]+/)
                    if(regHex.test(number)) {
                        return new vscode.Hover(`Decimal for ${number}: ${hexToDecimal(number)}`)
                    } else {
                        return new vscode.Hover(`Hex for ${number}: 0x${decimalToHex(number)}`)
                    }

                }
            }
        });

        const symbol = vscode.languages.registerDocumentSymbolProvider(
            { scheme: 'file', language: 'pokemon_ds_script' },
            new PokemonDSScriptSymbolProvider()
        );

        let changeFileCommand = vscode.commands.registerCommand('json-autocompletion.changeFile', changeFile);

        const changeThemeCommand = vscode.commands.registerCommand('extension.changeTheme', async () => {
            // Define the theme name you want to set
            const themeName = "Custom Script Theme";
        
            // Update the color theme setting
            await vscode.workspace.getConfiguration().update(
              'workbench.colorTheme',
              themeName,
              vscode.ConfigurationTarget.Workspace
            );
        
            vscode.window.showInformationMessage(`Theme changed to ${themeName}`);
          });

        let completionProvider = vscode.languages.registerCompletionItemProvider('javascript', {
            provideCompletionItems
        }, '.'); 

        updateStatusBar();


	    context.subscriptions.push(disposable, fileOpenListener, hoverProvider, provider, symbol, changeFileCommand, completionProvider, statusBarItem, changeThemeCommand);
}

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

    const filePath = path.join(vscode.workspace.rootPath, refFile);

    if (fs.existsSync(filePath)) {
        return filePath;
    }

    return null;
}

/*
    AUTOCOMPLETE
*/

let statusBarItem;
let statusBarItem2;

function updateStatusBar() {
    if (statusBarItem) {
        statusBarItem.dispose(); // Dispose previous item if it exists
        statusBarItem2.dispose();
    }

    // Create a new status bar item
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.text = `Autocompletion: ${currentFile}`;
    statusBarItem.command = 'json-autocompletion.changeFile'; // Command to open file picker
    statusBarItem.show();
    

    statusBarItem2 = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem2.text = "Pokemon DS Script Colors";
    statusBarItem2.command = "extension.changeTheme";
    statusBarItem2.show();
}

function getSuggestions(input) {
    const filePath = path.join(__dirname, currentFile);
    let data;
    try {
        data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
        vscode.window.showErrorMessage(`Failed to load ${currentFile}: ${err.message}`);
        return [];
    }

    // Look for keywords or methods matching the input
    let suggestions = [];
    Object.keys(data).forEach(key => {
        suggestions = suggestions.concat(data[key].filter(item => item.startsWith(input)));
    });

    return suggestions;
}

// Provide autocompletion
function provideCompletionItems(document, position) {
    const input = document.getText(document.getWordRangeAtPosition(position));
    const suggestions = getSuggestions(input);

    return suggestions.map(suggestion => {
        return new vscode.CompletionItem(suggestion, vscode.CompletionItemKind.Keyword);
    });
}

// Command to change the autocompletion JSON file
function changeFile() {
    vscode.window.showQuickPick(['scrcmd-hgss.json', 'scrcmd-plat.json', 'scrcmd-dp.json'], {
        placeHolder: 'Select the JSON file for autocompletion'
    }).then(selection => {
        if (selection) {
            currentFile = selection;
            vscode.window.showInformationMessage(`Autocompletion file changed to ${currentFile}`);
            updateStatusBar();
        }
    });
}

/*
    OUTLINE
*/

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


// This method is called when your extension is deactivated
function deactivate() {}

module.exports = {
	activate,
	deactivate
}
