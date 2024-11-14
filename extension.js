// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {

	console.log('Congratulations, your extension "dspre-script-support" is now active!');

	const fileOpenListener = vscode.workspace.onDidOpenTextDocument(async (document) => {
        const filePath = document.fileName;
        const fileName = path.basename(filePath);

        // Check if the opened file matches the naming convention
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
        { scheme: 'file', language: 'customscript' },
        {
            async provideDocumentLinks(document) {
                const links = [];
                const text = document.getText();
                const regex = /\b(Function#(\d+)|Script#(\d+)|Action#(\d+))\b/g;
                let match;
    
                // Search for references like Function#3, Script#3, Action#3 in the document
                while ((match = regex.exec(text)) !== null) {
                    const referencedNumber = match[2] || match[3] || match[4]; // Get the reference number
                    const refType = match[1]; // The type (Function, Script, Action)
                    
                    // Resolve the target file path based on the reference
                    const refFile = resolveFilePath(document.uri.fsPath, referencedNumber, refType);
                    
                    if (refFile) {
                        // Open the target file to search for the exact line of the reference
                        const targetDocument = await vscode.workspace.openTextDocument(refFile);
    
                        // Construct the label format to search in the target file
                        const targetLabelRegex = new RegExp(`^\\s*${refType.replace('#', ' ')}:`, 'i');
    
                        let targetLine = null;
                        
                        // Loop through each line in the target document to find the reference line
                        for (let line = 1; line < targetDocument.lineCount; line++) {
                            const lineText = targetDocument.lineAt(line).text;
                            if (targetLabelRegex.test(lineText)) {
                                targetLine = line;
                                break;
                            }
                        }
    
                        // Only add the link if the target line was found
                        if (targetLine !== null) {
                            // Create a document link pointing to the found line in the target file
                            const startPosition = document.positionAt(match.index);
                            const endPosition = document.positionAt(match.index + match[0].length);

                            const link = new vscode.DocumentLink(
                                new vscode.Range(startPosition, endPosition),
                                vscode.Uri.file(refFile)
                            );
    
                            // Set tooltip for clarity (optional)
                            link.tooltip = `Go to ${refType} in ${refFile}, line ${targetLine}`;
    
                            // Add the link to the list
                            links.push(link);
                        }
                    }
                }
                return links;
            }
        }
    );

	const hoverProvider = vscode.languages.registerHoverProvider('customscript', {
        provideHover(document, position) {
	
			const wordRange = document.getWordRangeAtPosition(position, /\b(Function#\d+|Script#\d+|Action#\d+)\b/);
            if (!wordRange) return;

            const word = document.getText(wordRange);

            const regex = /\b(Function#(\d+)|Script#(\d+)|Action#(\d+))\b/;
            const match = word.match(regex);
            if (match) {
				//console.log("match: ", match)
                const referencedNumber = match[2] || match[3] || match[4]; // Number after Function#, Script#, or Action#
                const refType = match[1]; // Type (Function, Script, Action)

                // Resolve file path for the reference
                const refFile = resolveFilePath(document.uri.fsPath, referencedNumber, refType);
                if (refFile) {
                    return new vscode.Hover(`Go to ${refType}`);
					
                }
            }
        }
    });

    const symbol = vscode.languages.registerDocumentSymbolProvider(
        { scheme: 'file', language: 'customscript' },
        new CustomScriptSymbolProvider()
    )


	context.subscriptions.push(disposable, fileOpenListener, hoverProvider, provider, symbol);
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

    let column = vscode.ViewColumn.One; // Start with the first column
    for (const file of files) {
        const fileUri = vscode.Uri.file(file);
        await vscode.workspace.openTextDocument(fileUri).then(doc => {
            vscode.window.showTextDocument(doc, { viewColumn: column, preview: false });
        });
        
        // Move to the next column, cycling through the first 3 columns
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
    const baseNumber = fileName.split('_')[0]; // Extract base number (e.g., 0000 from 0000_script.script)

    // Determine the file extension and reference type

	//let type =  refType.split("#")[0];

    let refFile;
	refType = refType.split('#')[0];
	console.log(refType)
    if (refType === 'Function') {
        refFile = `${baseNumber}_func.script`; // Function references are in .script files
    } else if (refType === 'Script') {
        refFile = `${baseNumber}_script.script`; // Script references are in .script files
    } else if (refType === 'Action') {
        refFile = `${baseNumber}_action.action`; // Action references are in .action files
    } else {
        return null;
    }

    // Resolve the full file path
    const filePath = path.join(vscode.workspace.rootPath, refFile);

    // Check if the file exists in the workspace
    if (fs.existsSync(filePath)) {
        return filePath;
    }

    return null; // Return null if the file doesn't exist
}

class CustomScriptSymbolProvider {
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
                // Add a Function symbol
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
                // Add an Action symbol
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
