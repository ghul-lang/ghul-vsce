import { DidChangeWatchedFilesParams, DidCloseTextDocumentParams, FileChangeType, TextDocuments } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';

import { DocumentChangeTracker, ReinitializableWorkspace } from '../src/document-change-tracker';
import { EditQueue } from '../src/edit-queue';
import { URI } from 'vscode-uri';


jest.mock('../src/edit-queue');
jest.mock('fs');

class RecordingWorkspace implements ReinitializableWorkspace {
    reinitialize = jest.fn();
}


// @ts-ignore
function _createDidCloseTextDocumentParams(uri: string): DidCloseTextDocumentParams {
    return {
        textDocument: {
            uri: uri
        }
    };
}

function createDidChangeWatchedFilesParams(uri: string, type: FileChangeType): DidChangeWatchedFilesParams {
    // return a complete object of type DidChangeWatchedFilesParams including all non-optional properties

    return {
        changes: [
            {
                uri: uri,
                type: type 
            }
        ]
    };
}

describe('DocumentChangeTracker', () => {
    let documentChangeTracker: DocumentChangeTracker;
    let workspace: RecordingWorkspace;
    let editQueue: EditQueue;
    let globs: string[];
    let openDocuments: { uri: string }[];
    let documents: TextDocuments<TextDocument>;

    beforeEach(() => {
        workspace = new RecordingWorkspace();
        globs = ['**/*.ghul'];

        editQueue = {
            queueEdit3:
                jest.fn((_uri: string, _version: number | null, _text: string) => { /* recorded by jest */ })
        } as unknown as EditQueue;

        // Per-test list of editor buffers the tracker should treat as open.
        openDocuments = [];

        documents = {
            all: () => openDocuments
        } as unknown as TextDocuments<TextDocument>;

        documentChangeTracker = new DocumentChangeTracker(workspace, editQueue, globs, documents);
    });

    it('should queue edit with empty file text for deleted files', () => {
        const uri = 'file:///path/to/document.ghul';
        const type = FileChangeType.Deleted;

        const params = createDidChangeWatchedFilesParams(uri, type);

        documentChangeTracker.onDidChangeWatchedFiles(params);

        expect(editQueue.queueEdit3).toHaveBeenCalledWith(uri, null, "");
    });

    it('should return the valid source file', () => {
        const path = '/path/to/document.ghul';
        const uri = URI.file(path).toString();
        const validSourceFile = documentChangeTracker.tryGetValidSourceFile(uri);

        expect(validSourceFile).toBe(path);
    });

    it('should return null for a source file an exclude pattern matches', () => {
        documentChangeTracker = new DocumentChangeTracker(
            workspace, editQueue, globs, documents, [], ['**/stand-in.ghul']
        );

        expect(documentChangeTracker.tryGetValidSourceFile(URI.file('/path/to/stand-in.ghul').toString())).toBeNull();
        expect(documentChangeTracker.tryGetValidSourceFile(URI.file('/path/to/task.ghul').toString())).toBe('/path/to/task.ghul');
    });

    it('should return null for an invalid source file', () => {
        const uri = 'file:///path/to/document.js';
        const invalidSourceFile = documentChangeTracker.tryGetValidSourceFile(uri);

        expect(invalidSourceFile).toBeNull();
    });

    it('should return the valid source file for a Windows path', () => {
        const path = 'C:\\path\\to\\document.ghul';
        const uri = URI.file(path).toString();
        const validSourceFile = documentChangeTracker.tryGetValidSourceFile(uri);

        expect(validSourceFile?.toLowerCase()).toBe(path.toLowerCase());
    });

    it('should send an edit for a newly created file with contents read from disk', () => {
        const uri = 'file:///path/to/document.ghul';
        const type = FileChangeType.Created;

        // mock fs.readFileSync to return "contents of file"

        const fs = require('fs');
        fs.readFileSync = jest.fn(() => "contents of file");

        const params = createDidChangeWatchedFilesParams(uri, type);

        documentChangeTracker.onDidChangeWatchedFiles(params);

        expect(editQueue.queueEdit3).toHaveBeenCalledWith(uri, null, "contents of file");
    });

    it('reloads a closed file from disk when it changes on disk (e.g. a git pull)', () => {
        const uri = 'file:///path/to/document.ghul';

        const fs = require('fs');
        fs.readFileSync = jest.fn(() => "new contents from disk");

        const params = createDidChangeWatchedFilesParams(uri, FileChangeType.Changed);

        documentChangeTracker.onDidChangeWatchedFiles(params);

        expect(editQueue.queueEdit3).toHaveBeenCalledWith(uri, null, "new contents from disk");
    });

    it('does not reload an open file when it changes on disk — the editor buffer is the source of truth', () => {
        const uri = 'file:///path/to/document.ghul';

        // The file is open in an editor, so textDocument sync owns it:
        openDocuments.push({ uri });

        const fs = require('fs');
        fs.readFileSync = jest.fn(() => "saved contents from disk");

        const params = createDidChangeWatchedFilesParams(uri, FileChangeType.Changed);

        documentChangeTracker.onDidChangeWatchedFiles(params);

        expect(editQueue.queueEdit3).not.toHaveBeenCalled();
    });

    it('does not reload an open file on a Created event either', () => {
        const uri = 'file:///path/to/document.ghul';

        openDocuments.push({ uri });

        const fs = require('fs');
        fs.readFileSync = jest.fn(() => "contents from disk");

        const params = createDidChangeWatchedFilesParams(uri, FileChangeType.Created);

        documentChangeTracker.onDidChangeWatchedFiles(params);

        expect(editQueue.queueEdit3).not.toHaveBeenCalled();
    });

    it('returns early when params has no changes', () => {
        documentChangeTracker.onDidChangeWatchedFiles({ changes: undefined } as any);

        expect(editQueue.queueEdit3).not.toHaveBeenCalled();
    });

    it('returns early when params itself is null-ish', () => {
        documentChangeTracker.onDidChangeWatchedFiles(null as any);

        expect(editQueue.queueEdit3).not.toHaveBeenCalled();
    });

    it('returns null for a non-file:// uri (tryGetValidSourceFile)', () => {
        expect(documentChangeTracker.tryGetValidSourceFile('http://example.com/x.ghul')).toBeNull();
        expect(documentChangeTracker.tryGetValidSourceFile('untitled:foo.ghul')).toBeNull();
    });

    it('ignores changes for files that fall outside the configured globs', () => {
        // .js doesn't match **/*.ghul → tryGetValidSourceFile returns null,
        // the loop continues without queueing:
        const params = createDidChangeWatchedFilesParams(
            'file:///path/to/document.js',
            FileChangeType.Created
        );

        documentChangeTracker.onDidChangeWatchedFiles(params);

        expect(editQueue.queueEdit3).not.toHaveBeenCalled();
    });

    describe('project-file changes trigger a debounced re-initialise', () => {
        // The tracker calls workspace.reinitialize() via a 5-second debounce;
        // fake timers keep that schedule from firing during the test.
        beforeAll(() => { jest.useFakeTimers(); });
        afterAll(() => { jest.useRealTimers(); });

        it.each([
            ['file:///workspace/test.ghulproj'],
            ['file:///workspace/Directory.Build.props'],
            ['file:///workspace/.config/dotnet-tools.json'],
        ])('returns after seeing a project-relevant change for %s (does not queue)', uri => {
            const params = createDidChangeWatchedFilesParams(uri, FileChangeType.Changed);

            documentChangeTracker.onDidChangeWatchedFiles(params);

            // The function returns early after scheduling the debounced reinitialise:
            expect(editQueue.queueEdit3).not.toHaveBeenCalled();
        });

        it('a .block-compiler change reinitialises the workspace immediately', () => {
            const params = createDidChangeWatchedFilesParams(
                'file:///workspace/.block-compiler',
                FileChangeType.Created
            );

            documentChangeTracker.onDidChangeWatchedFiles(params);

            expect(workspace.reinitialize).toHaveBeenCalledTimes(1);
        });
    });

    describe('a referenced assembly arriving re-initialises the workspace', () => {
        const MISSING = '/workspace/lib/bin/Debug/net10.0/lib.dll';

        beforeAll(() => { jest.useFakeTimers(); });
        afterAll(() => { jest.useRealTimers(); });

        beforeEach(() => {
            documentChangeTracker = new DocumentChangeTracker(
                workspace, editQueue, globs, documents, [MISSING]
            );
        });

        it('re-initialises once an absent referenced assembly appears', () => {
            documentChangeTracker.onDidChangeWatchedFiles(
                createDidChangeWatchedFilesParams(URI.file(MISSING).toString(), FileChangeType.Created)
            );

            jest.advanceTimersByTime(5000);

            expect(workspace.reinitialize).toHaveBeenCalledTimes(1);
        });

        it('ignores an assembly of the same name built somewhere else', () => {
            documentChangeTracker.onDidChangeWatchedFiles(
                createDidChangeWatchedFilesParams(
                    URI.file('/workspace/other/bin/Debug/net10.0/lib.dll').toString(),
                    FileChangeType.Created
                )
            );

            jest.advanceTimersByTime(5000);

            expect(workspace.reinitialize).not.toHaveBeenCalled();
        });

        it('ignores assembly changes once nothing is missing', () => {
            // The routine rebuild during editing rewrites these constantly;
            // with the reference set complete none of it may reach the
            // workspace, or the analyser would recycle on every build.
            documentChangeTracker = new DocumentChangeTracker(
                workspace, editQueue, globs, documents, []
            );

            documentChangeTracker.onDidChangeWatchedFiles(
                createDidChangeWatchedFilesParams(URI.file(MISSING).toString(), FileChangeType.Changed)
            );

            jest.advanceTimersByTime(5000);

            expect(workspace.reinitialize).not.toHaveBeenCalled();
        });
    });
});