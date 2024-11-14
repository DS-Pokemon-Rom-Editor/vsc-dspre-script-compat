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
			provideDocumentLinks(document) {
				const links = [];
				const text = document.getText();
				const regex = /\b(Function#(\d+)|Script#(\d+)|Action#(\d+))\b/g; // Use global regex
				let match;
	
				// Search for references like Function#3, Script#3, Action#3 in the document
				while ((match = regex.exec(text)) !== null) {
					//console.log("Match found:", match); // Debug log to see the match details
	
					// Get the referenced number and type
					const referencedNumber = match[2] || match[3] || match[4]; // Get the number
					const refType = match[1]; // The type (Function, Script, Action)
	
					// Resolve the file path based on the reference

					const refFile = resolveFilePath(document.uri.fsPath, referencedNumber, refType);
					console.log(refFile)
					if (refFile) {
						// Get the exact position in the document
						const position = document.positionAt(match.index);
						const line = position.line;
	
						console.log("Line found for match:", line, refType, referencedNumber); // Debug log to see the line
	
						// Create a document link for the reference
						const link = new vscode.DocumentLink(
							new vscode.Range(new vscode.Position(line, position.character), new vscode.Position(line, position.character + match[0].length)),
							vscode.Uri.file(refFile)
						);
						links.push(link);
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
				console.log("match: ", match)
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



	context.subscriptions.push(disposable, fileOpenListener, hoverProvider, provider);
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

// Updated getLineFromReference to use the correct line number logic
function getLineFromReference(document, index) {
    // Use document.positionAt() to get the correct position
    const position = document.positionAt(index); 
    return position.line; // This will return the correct line number
}


// This method is called when your extension is deactivated
function deactivate() {}

module.exports = {
	activate,
	deactivate
}
