# Agent research orchestration as of September 8, 2026

## Recommendation

For autoresearch-style coding, retrieval, and prompt optimization, start with one coordinator and a deterministic experiment runner. Add a small number of independent workers for separable questions or candidate implementations. Give one controller exclusive authority to accept changes. Protect the evaluator and final test data from the optimizing workers.

This is an engineering recommendation informed by the sources below, not a directly validated best architecture for mical-pi. Compare it against a single-agent baseline at matched cost before increasing complexity.

## Scope and evidence quality

Primary-source browser review conducted September 8, 2026. The newest verified papers were submitted September 4. This is a targeted review, not an exhaustive survey or a claim of settled consensus. September papers are new preprints without independent replication established in this review.

The parent agent verified all six sources below with agent-browser. For TruthInsightBench, it also read the full-paper experimental setup, results, limitations, and conclusion. For the other papers, findings below are limited to verified abstracts. Anthropic's source is a first-party engineering report rather than a controlled academic comparison.

## Findings

### Coordination must match task dependencies

[Towards a Science of Scaling Agent Systems](https://arxiv.org/abs/2512.08296), first submitted December 9, 2025; revised April 8, 2026, evaluates 260 configurations across six benchmarks, five architectures, and three model families with standardized tools, prompts, and compute. Relative performance versus single-agent baselines ranges from +80.8% on decomposable financial reasoning to -70.0% on sequential planning. Tool-heavy tasks incur coordination overhead; architectures without centralized verification tend to propagate more errors.

Its predictive model has cross-validated R² of 0.373, or 0.413 using a task-grounded capability measure. Treat the results as evidence of task dependence, not a universal formula for choosing agent counts.

Implication: parallelize independent source searches, hypotheses, and isolated candidate changes. Keep tightly dependent edits and final integration under one owner. Compare alternatives at equal total inference and experiment budgets.

### Parallel research is useful, but the gains cost more

[How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system), June 13, 2025, reports a 90.2% improvement over single-agent Opus 4 on an internal research evaluation using Opus 4 as lead and Sonnet 4 workers. The report favors breadth-first questions with independent investigation paths. It also reports multi-agent systems using about 15 times the tokens of ordinary chats, not 15 times the tokens of single-agent research.

The comparison does not isolate architecture at matched cost. It supports parallel source gathering as a production pattern, not a claim that adding workers is always more efficient.

Useful implementation details include explicit worker objectives, output formats, task boundaries, and source guidance. Workers can save full artifacts and return references rather than repeatedly summarizing large outputs through the coordinator.

### Put repetitive execution in code, interpretation in agents

[La Agente Óptima: Towards Agentic Self-Driving Laboratories](https://arxiv.org/abs/2609.04564), September 3, 2026, separates LLM reasoning from persistent Bayesian optimization campaigns. Routine optimization proceeds without reconstructing the campaign through the LLM each time; interpretation and campaign revision return control to the agent.

The abstract describes ablations, five digital tasks, and two physical platforms. One five-day flow-chemistry campaign increased yield from 30% to 59% over 23 experiments. Another identified a measurement failure and inferred that the target was likely unattainable with the available reagents. These are encouraging demonstrations; the retrieved abstract does not establish a randomized matched-budget advantage over human research.

Implication: use scripts for queues, timeouts, state transitions, measurement, acceptance, and rollback. Use agents for proposing changes and interpreting anomalies. For numeric parameter spaces, consider Bayesian optimization or simpler search methods instead of spending an LLM call on every candidate.

### Running analyses is different from establishing a result

[TruthInsightBench](https://arxiv.org/abs/2609.05079), September 4, 2026, evaluates 40 blind discovery tasks across ten domains. Four coding-agent systems score 58.4–60.3 out of 100, with no statistically reliable pairwise separation. Reported strengths concern execution and documentation; weaknesses concern controls, robustness, falsifiability, and cross-dataset generalization.

Important limits from the [full paper](https://arxiv.org/html/2609.05079v1):

- All systems use DeepSeek-V4-Flash with thinking disabled, one run per task.
- A single GLM-5.1 judge uses quantized weights and disabled thinking.
- Human-expert calibration and second-judge sensitivity analysis remain future work.
- Per-system prompts, resource limits, tool-call limits, network permissions, failure rules, and the evaluated systems' run artifacts are not released.

These limits make it preliminary evidence, not a frontier-model ranking or proof that scientific discovery is generally impossible.

Implication: require attempts to disprove a candidate improvement. A report, passing execution, or attractive score alone does not establish generalization.

### Agreement between agents is not independent verification

[Evidence Integration in Large Language Models](https://arxiv.org/abs/2609.04290), September 3, 2026, reports over ten million trials across twelve models, four families, and eight domains. The authors find that models more readily incorporate errors characteristic of themselves, and that identical external evidence can improve weaker receivers while harming stronger ones.

The abstract reports extreme candidate-incorporation rates under particular experimental conditions, including cases where a model internally identifies a candidate as invalid. Those percentages are not general error rates for real research agents. Full methods were not reviewed here.

Implication: separate initial investigations before sharing proposals. Give reviewers raw evidence and a requirement to construct a failing test. A second model's approval is weaker than a reproducible measurement. Different sessions, roles, or model families do not by themselves establish independence or correctness.

### Adapt the remaining plan to observed results

[TROVE: Adaptive Agent Skill Orchestration via Trace-Grounded Route Validation and Editing](https://arxiv.org/abs/2609.05019), September 4, 2026, proposes retaining valid workflow fragments and changing only continuations invalidated by execution evidence. Its abstract reports quality-efficiency improvements across code, question-answering, and math benchmarks, including efficiency benefits from early termination. Exact effect sizes and full methods were not inspected in this review.

Implication: after a measurement failure, repair the measurement path rather than blindly advancing the experiment count or restarting all research. Preserve validated work. Treat a planned agent sequence as provisional.

## Proposed mical-pi experiment design

The following choices are recommendations, not measured optima:

1. Define the research question, correctness guards, editable files, cost budget, wall-clock limit, and acceptance rule before running agents.
2. Establish a single-agent baseline.
3. Try two or three independent candidate workers in isolated worktrees. Each returns a hypothesis, patch, expected failure modes, and artifact references. Workers do not edit acceptance tests or final evaluation data.
4. Use a deterministic controller to run candidates against a frozen development evaluator. Repeat noisy baseline and candidate measurements under matched conditions. Reject malformed output, failed guards, and timeouts explicitly.
5. Give a separate reviewer the candidate and evidence. Ask for counterexamples, leakage checks, and regression tests rather than approval or a numerical confidence score.
6. Confirm selected candidates on an untouched final test set. Repeatedly consulting a holdout turns it into development data; provision new final data when needed.
7. Let one controller accept or reject the candidate. Record the code revision, data and evaluator hashes, model and prompt versions, seeds, tool versions, cost, runtime, unsuccessful attempts, and decision.
8. Stop for budget exhaustion, verified success, broken measurement, or insufficient expected value. Spending every available iteration is not a research objective.

For retrieval work, separate development queries from final queries, include unfamiliar repositories or query families, and measure relevance alongside latency and indexing cost. Prevent workers from changing relevance labels, query sets, or scoring logic. For prompt optimization, evaluate downstream task success rather than keyword coverage or prompt length.

Compare orchestration strategies using verified improvement per dollar, time to a reproducible accepted result, and regression rate. Use matched budgets and multiple runs. Agent count and iteration count are resource measures, not outcomes.

## Changes suggested for autoresearch-skill

Preserve the useful hypothesis/experiment/log structure. Before unattended use, replace prompt-only loop control with explicit machine state and enforce execution limits outside the agent. Repair the runner's text-based completion detection, which the import review reproduced treating `target not met` as completion. Add Pi support, isolated workspaces, protected evaluators, repeat measurements, and a structured final acceptance step.

Do not implement a general agent debate system first. Test whether a small independent candidate pool actually beats one capable agent on the user's own workload.
