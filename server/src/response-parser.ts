import { ResponseHandler } from './response-handler';

import { Watchdog } from './watchdog';

import { log } from './log';

export class ResponseParser {
    buffer: string;
    response_handler: ResponseHandler;
    watchdog: Watchdog;

    constructor(
        response_handler: ResponseHandler,
        watchdog: Watchdog
    ) {
        this.buffer = '';
        this.response_handler = response_handler;
        this.watchdog = watchdog;
    }

    // Drop any half-received line. Called on every (re)launch: a compiler
    // killed mid-line leaves a partial message behind, and without this the
    // replacement compiler's first message — its LISTEN — is concatenated onto
    // that fragment, fails to parse, and the project is never analysed.
    reset() {
        this.buffer = '';
    }

    handleChunk(chunk: string) {
        chunk = chunk.replace(/\r/g, '');

        this.buffer += chunk;

        let lines = this.buffer.split('\n');

        // The last element is the (possibly empty) partial line after the final
        // newline; hold it back until the rest of it arrives.
        this.buffer = lines.pop();

        for (let line of lines) {
            if (line.length > 0) {
                this.handleLine(line);
            }
        }
    }

    handleLine(line: string) {
        let message: any;

        try {
            message = JSON.parse(line);
        } catch (e) {
            log("response parser: protocol error: could not parse JSON message: " + e);
            this.response_handler.rejectAllPendingPromises("response parser: protocol error: could not parse JSON message: " + e);
            return;
        }

        // Every message clears the watchdog: the compiler is alive and talking.
        this.watchdog.clearWatchdog();

        switch (message.kind) {
        case "listen":
            this.response_handler.handleListen(message);
            break;

        case "diagnostics":
            this.response_handler.handleDiagnostics(message);
            break;

        case "code_actions":
            this.response_handler.handleCodeActions(message);
            break;

        case "hover":
            this.response_handler.handleHover(message);
            break;

        case "definition":
            this.response_handler.handleDefinition(message);
            break;

        case "declaration":
            this.response_handler.handleDeclaration(message);
            break;

        case "completion":
            this.response_handler.handleCompletion(message);
            break;

        case "signature":
            this.response_handler.handleSignature(message);
            break;

        case "symbols":
            this.response_handler.handleSymbols(message);
            break;

        case "references":
            this.response_handler.handleReferences(message);
            break;

        case "implementation":
            this.response_handler.handleImplementation(message);
            break;

        case "type_definition":
            this.response_handler.handleTypeDefinition(message);
            break;

        case "rename":
            this.response_handler.handleRenameRequest(message);
            break;

        case "restart":
            this.response_handler.handleRestart();
            break;

        case "exit":
            this.response_handler.handleExit(message.reason);
            break;

        case "heap_check":
            this.response_handler.handleHeapCheckDone();
            break;

        case "format":
            this.response_handler.handleDocumentFormatting(message);
            break;

        case "format_range":
            this.response_handler.handleDocumentRangeFormatting(message);
            break;

        case "semantic_tokens":
            this.response_handler.handleSemanticTokens(message);
            break;

        case "inlay_hints":
            this.response_handler.handleInlayHints(message);
            break;

        case "add_references":
            this.response_handler.handleAddReferences(message);
            break;

        case "stats":
            this.response_handler.handleStats(message);
            break;

        case "memory_usage":
            this.response_handler.handleMemoryUsage(message);
            break;

        case "error":
            this.response_handler.handleError(message);
            break;

        default:
            // not a known kind, but compiler presumably still alive
            this.response_handler.handleUnexpected();
        }
    }
}
