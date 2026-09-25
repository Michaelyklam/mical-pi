/** Methods installed into Pi's AgentSession by the maintained source patch.
 * Free functions below resolve in Pi's original module, not in this file.
 * One pending request and one active operation; no additional task scheduler.
 *
 * Lifetime model: one session-owned operation chooses its outcome exactly once,
 * at the authoritative context commit (or its failure), and cleans up exactly
 * once. Completion is REGISTERED before any awaited work (the session_before_compact
 * event's registerCompletion) and delivered exactly once at the decided outcome, so
 * failure, cancellation and timeout all finish their bookkeeping. All informational
 * delivery goes through one guarded boundary and can neither re-decide the outcome
 * nor hold the operation. Run settlement resolves a queued request whose run ended
 * before the between-turn safe point and publishes both settled events exactly once,
 * only when ready after all asynchronous handlers.
 */
export class SessionCompactionMethods {
  requestCompaction(options = {}) {
    const timeoutMs = options.timeoutMs ?? 300_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) throw new Error("Compaction timeout must be between 1 and 2147483647 ms.");
    if (this._compactionOperation) throw new Error("Compaction is already in progress.");
    if (this._requestedCompaction) {
      if (this._requestedCompaction.options.customInstructions !== options.customInstructions) {
        throw new Error("A different compaction request is already pending.");
      }
      this._requestedCompaction.callbacks.push(options);
      return;
    }
    this._requestedCompaction = { options: { ...options, timeoutMs }, callbacks: [options] };
    if (!this.isStreaming) void this._runRequestedCompaction();
  }

  async _runRequestedCompaction() {
    const request = this._requestedCompaction;
    if (!request) return;
    this._requestedCompaction = undefined;
    try {
      await this._compactSession("manual", false, request.options.customInstructions, {
        withinRun: true, timeoutMs: request.options.timeoutMs, signal: this.agent.signal, request,
      });
    } catch {
      // The outcome was already delivered by the operation's notification boundary.
    }
  }

  _reportNotificationError(event, error) {
    try {
      this._extensionRunner.emitError?.({ extensionPath: "<compaction>", event, error: String(error) });
    } catch { /* Reporting must never fail the operation either. */ }
  }

  /** The one informational delivery boundary: never throws, never rejects. */
  _notify(event, fn) {
    try {
      return Promise.resolve(fn()).then(undefined, error => this._reportNotificationError(event, error));
    } catch (error) {
      this._reportNotificationError(event, error);
      return Promise.resolve(undefined);
    }
  }

  _notifyCompactionRequest(request, result, error) {
    for (const callback of request.callbacks) {
      try {
        if (error) callback.onError?.(error);
        else callback.onComplete?.(result);
      } catch (callbackError) {
        this._reportNotificationError("compaction_callback", callbackError);
      }
    }
  }

  /** The run that queued the request ended before the between-turn safe point. */
  _settleRequestedCompaction() {
    const request = this._requestedCompaction;
    if (!request) return;
    this._requestedCompaction = undefined;
    this._notifyCompactionRequest(request, undefined, new Error("The run ended before compaction started. The saved note is kept; retry self_compact({}) to reuse it."));
  }

  compact(customInstructions) {
    if (this._requestedCompaction) return Promise.reject(new Error("Compaction is already requested for the next turn."));
    return this._compactSession("manual", false, customInstructions);
  }

  _compactSession(reason, willRetry, customInstructions, options = {}) {
    const active = this._compactionOperation;
    if (active) {
      if (active.reason === reason && active.customInstructions === customInstructions) return active.promise;
      return Promise.reject(new Error("Compaction is already in progress."));
    }
    const controller = new AbortController();
    const operation = { controller, reason, willRetry, customInstructions, request: options.request, fromExtension: false, completion: undefined, delivered: false };
    this._compactionOperation = operation;
    // Defer execution so even synchronous callbacks observe the shared promise.
    operation.promise = Promise.resolve().then(async () => {
      const { signal } = controller;
      const abortFromRun = () => controller.abort(options.signal.reason);
      if (options.signal?.aborted) abortFromRun();
      else options.signal?.addEventListener("abort", abortFromRun, { once: true });
      const timer = setTimeout(() => controller.abort(new Error("Compaction timed out.")), options.timeoutMs ?? 300_000);
      let removeAbortListener = () => {};
      const aborted = new Promise((_, reject) => {
        const stop = () => reject(signal.reason instanceof Error ? signal.reason : Object.assign(new Error("Compaction cancelled"), { compactionCancelled: true }));
        if (signal.aborted) stop();
        else {
          signal.addEventListener("abort", stop, { once: true });
          removeAbortListener = () => signal.removeEventListener("abort", stop);
        }
      });
      aborted.then(undefined, () => {}); // consumed by the race below or nowhere; never unhandled
      let outcome;
      try {
        await this._notify("compaction_start", () => this._emit({ type: "compaction_start", reason }));
        const summarize = async () => {
          if (reason === "manual" && !options.withinRun) await this.abort(true);
          signal.throwIfAborted();
          const model = this.model;
          if (!model) throw new Error("No model selected for compaction.");
          const auth = await this._getSummarizationRequestAuth(model, signal);
          signal.throwIfAborted();
          const branchEntries = this.sessionManager.getBranch();
          const leaf = this.sessionManager.getLeafId();
          const preparation = prepareCompaction(branchEntries, this.settingsManager.getCompactionSettings(model));
          if (!preparation) throw new Error("Nothing to compact (session too small or already compacted).");
          const hook = this._extensionRunner.hasHandlers("session_before_compact")
            ? await this._extensionRunner.emit({
                type: "session_before_compact", preparation, branchEntries, customInstructions, reason, willRetry, signal,
                // Owned by this operation: registration is synchronous at hook entry, before any
                // awaited work, and is delivered exactly once at the decided outcome. A registration
                // after delivery is ignored so late dispatches cannot claim newer state.
                registerCompletion: (callback) => { if (!operation.delivered && typeof callback === "function") operation.completion = callback; },
              })
            : undefined;
          signal.throwIfAborted();
          // An explicit cancel stays a cancellation; a hook failure carries its own cause.
          if (hook?.cancel) throw hook.error instanceof Error ? hook.error : Object.assign(new Error("Compaction cancelled"), { compactionCancelled: true });
          operation.fromExtension = !!hook?.compaction;
          const result = hook?.compaction ?? await this._runDefaultCompaction(
            preparation, auth.model, auth.apiKey, auth.headers, customInstructions, signal, auth.env, reason,
          );
          signal.throwIfAborted();
          // Extension state entries may be appended by the hook. Reject changes to conversation
          // history, not bookkeeping entries, before replacing the model's context.
          const current = this.sessionManager.getBranch();
          const after = leaf ? current.slice(current.findIndex((entry) => entry.id === leaf) + 1) : current;
          if ((leaf && !current.some((entry) => entry.id === leaf)) || after.some((entry) => entry.type !== "custom")) {
            throw new Error("Session history changed during compaction. Retry against the current history.");
          }
          return result;
        };
        // A provider ignoring abort can finish later, but it never owns the commit below.
        const result = await Promise.race([summarize(), aborted]);
        signal.throwIfAborted();
        if (this._compactionOperation !== operation) throw new Error("Compaction is no longer current.");
        const { summary, firstKeptEntryId, tokensBefore, details, usage } = result;
        this.sessionManager.appendCompaction(summary, firstKeptEntryId, tokensBefore, details, operation.fromExtension, usage);
        // Pi 0.87: the session projection is the model's context; this also maps entry ids.
        this._refreshFinalizedContext();
        outcome = {
          result: { ...result, estimatedTokensAfter: estimateMessagesTokens(this.agent.state.messages) },
          compactionEntry: this.sessionManager.getLeafEntry(),
        };
      } catch (error) {
        const failure = {
          reason,
          aborted: !!(error && (error.compactionCancelled === true || error.name === "AbortError")),
          willRetry: false,
          errorMessage: error instanceof Error ? error.message : String(error),
        };
        outcome = { error: error instanceof Error ? error : new Error(failure.errorMessage), failure };
      } finally {
        // One cleanup, at the outcome: the operation can no longer exist or fail.
        clearTimeout(timer);
        removeAbortListener();
        options.signal?.removeEventListener("abort", abortFromRun);
        this._releaseCompaction(operation);
      }
      await this._notifyOutcome(operation, outcome);
      if (outcome.error) throw outcome.error;
      return outcome.result;
    });
    return operation.promise;
  }

  _releaseCompaction(operation) {
    if (this._compactionOperation !== operation) return;
    this._compactionOperation = undefined;
    // Pi 0.87 counts compaction as busy in isIdle; release idle waiters before notifying,
    // as native compaction does, so compaction_end listeners can submit prompts.
    this._resolveIdleWaitIfIdle();
  }

  /**
   * The single notification boundary for a decided outcome. Registered completion
   * bookkeeping runs first, then externally supplied request callbacks, then the
   * informational events. Nothing here can re-decide the outcome or re-run the seam.
   */
  async _notifyOutcome(operation, outcome) {
    operation.delivered = true;
    const completion = operation.completion;
    operation.completion = undefined;
    const settled = outcome.result
      ? { committed: true, result: outcome.result }
      : { committed: false, error: outcome.error, aborted: outcome.failure.aborted };
    await this._notify("compaction_callback", () => completion?.(settled));
    await this._notify("compaction_callback", () => {
      if (!operation.request) return;
      if (outcome.result) this._notifyCompactionRequest(operation.request, outcome.result, undefined);
      else this._notifyCompactionRequest(operation.request, undefined, outcome.error);
    });
    await this._notify("compaction_end", () => this._emit(outcome.result
      ? { type: "compaction_end", reason: operation.reason, result: outcome.result, aborted: false, willRetry: operation.willRetry }
      : { type: "compaction_end", ...outcome.failure, result: undefined }));
    await this._notify("agent_settled", () => this._settleIfIdle());
    // Extension notifications are observational and may stall; they never hold the operation.
    void this._notify("session_compact", () => outcome.result
      ? this._extensionRunner.emit({ type: "session_compact", compactionEntry: outcome.compactionEntry, fromExtension: operation.fromExtension, reason: operation.reason, willRetry: operation.willRetry })
      : this._extensionRunner.emit({ type: "session_compact_failed", ...outcome.failure, fromExtension: operation.fromExtension }));
  }

  async _runAutoCompaction(reason, willRetry) {
    // Never await our own operation from the post-run callback of a manual abort.
    if (this._compactionOperation || this._requestedCompaction) return false;
    // Native auto-compaction is silent when there is nothing to compact.
    const model = this.model;
    if (!model || !prepareCompaction(this.sessionManager.getBranch(), this.settingsManager.getCompactionSettings(model))) return false;
    try {
      await this._compactSession(reason, willRetry);
      // Pi 0.87 omits the failed attempt from the projection (_omitRecoveryAttempt) before
      // compaction, so the refreshed context is already continuable.
      if (willRetry) return true;
      return this.agent.hasQueuedMessages();
    } catch {
      return false; // The outcome was already delivered by the session owner.
    }
  }

  abortCompaction() {
    const request = this._requestedCompaction;
    this._requestedCompaction = undefined;
    this._compactionOperation?.controller.abort(Object.assign(new Error("Compaction cancelled"), { compactionCancelled: true }));
    this._compactionAbortController?.abort();
    this._autoCompactionAbortController?.abort();
    if (request) this._notifyCompactionRequest(request, undefined, new Error("Compaction cancelled"));
  }

  async abort(preserveCompaction = false) {
    if (this._isAgentRunActive) this._agentRunAbortRequested = true;
    this.abortRetry();
    if (!preserveCompaction) this.abortCompaction();
    this.abortBranchSummary();
    if (this._isBeforeSettle) this._abortDuringBeforeSettle = true;
    this.agent.abort();
    // Manual compaction aborts the run from inside its own operation. isIdle includes
    // isCompacting in Pi 0.87, so waiting for idle there would wait on itself.
    if (preserveCompaction) await this._waitForAgentRunEnd();
    else await this.waitForIdle();
  }

  _waitForAgentRunEnd() {
    if (!this._isAgentRunActive) return Promise.resolve();
    return new Promise(resolve => (this._agentRunEndWaiters = this._agentRunEndWaiters ?? []).push(resolve));
  }

  _resolveAgentRunEnd() {
    const waiters = this._agentRunEndWaiters;
    this._agentRunEndWaiters = undefined;
    for (const resolve of waiters ?? []) resolve();
  }

  get isCompacting() {
    return !!(this._requestedCompaction || this._compactionOperation || this._compactionAbortController || this._autoCompactionAbortController || this._branchSummaryAbortController);
  }

  async _settleIfIdle() {
    if (this._settleOwed && !this.isStreaming && !this.isCompacting) await this._emitAgentSettled();
  }

  /**
   * One settlement record owns its notification-in-progress and its publication:
   * the extension event exactly once, then (only when still ready after all
   * asynchronous handlers) the public one exactly once. A nested settlement joins
   * the owner without publishing early, repeating events, or awaiting it (a nested
   * run must never deadlock against its own settlement).
   */
  async _emitAgentSettled() {
    this._isAgentRunActive = false;
    this._resolveAgentRunEnd();
    let owner = false;
    try {
      // A queued request whose run ended before the safe point settles here; it never
      // starts model work and never survives into the idle state.
      this._settleRequestedCompaction();
      if (this.isCompacting) {
        this._settleOwed = this._settleOwed ?? {};
        return;
      }
      const owed = (this._settleOwed = this._settleOwed ?? {});
      if (owed.notifying) return; // an active settlement owns notification and publication
      owner = true;
      if (!owed.extensionsNotified) {
        owed.extensionsNotified = true;
        owed.notifying = true;
        // Pi 0.87 defers prompts submitted from settled handlers until publication ends.
        this._isEmittingAgentSettled = true;
        try {
          await this._notify("agent_settled", () => this._extensionRunner.emit({ type: "agent_settled" }));
        } finally {
          this._isEmittingAgentSettled = false;
          owed.notifying = false;
        }
      }
      if (this.isStreaming || this.isCompacting) return; // readiness, after asynchronous handlers
      this._settleOwed = undefined;
      this._cacheWarmer?.onAgentSettled();
      this._isEmittingAgentSettled = true;
      try {
        await this._notify("agent_settled", () => this._emit({ type: "agent_settled" }));
      } finally {
        this._isEmittingAgentSettled = false;
      }
    } finally {
      try {
        // Only the owning settlement drains deferred actions, after both events.
        if (owner) for (const action of this._deferredSettledActions?.splice(0) ?? []) await action();
      } finally {
        this._resolveIdleWaitIfIdle();
      }
    }
  }
}
