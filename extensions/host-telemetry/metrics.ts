import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { cpus, freemem, totalmem } from "node:os";
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";

export interface CpuTimes {
	idle: number;
	total: number;
}

export interface SystemMetrics {
	cpuPercent?: number;
	ramPercent?: number;
	gpuPercent?: number;
}

const clampPercent = (value: number): number => Math.max(0, Math.min(100, value));

export function readCpuTimes(): CpuTimes {
	let idle = 0;
	let total = 0;
	for (const cpu of cpus()) {
		idle += cpu.times.idle;
		total += Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
	}
	return { idle, total };
}

export function cpuPercent(previous: CpuTimes, current: CpuTimes): number | undefined {
	const totalDelta = current.total - previous.total;
	const idleDelta = current.idle - previous.idle;
	if (totalDelta <= 0 || idleDelta < 0) return undefined;
	return clampPercent((1 - idleDelta / totalDelta) * 100);
}

export function linuxRamPercent(meminfo: string): number | undefined {
	const values = new Map<string, number>();
	for (const line of meminfo.split("\n")) {
		const match = /^(\w+):\s+(\d+)\s+kB$/.exec(line.trim());
		if (match) values.set(match[1]!, Number(match[2]));
	}
	const total = values.get("MemTotal");
	const available = values.get("MemAvailable");
	if (!total || available === undefined) return undefined;
	return clampPercent(((total - available) / total) * 100);
}

export function macRamPercent(vmStat: string, totalBytes: number): number | undefined {
	const pageSize = Number(/page size of (\d+) bytes/.exec(vmStat)?.[1]);
	if (!pageSize || !totalBytes) return undefined;
	const pages = (label: string): number => {
		const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		return Number(new RegExp(`^${escaped}:\\s+(\\d+)\\.`, "m").exec(vmStat)?.[1] ?? 0);
	};
	const reclaimablePages = pages("Pages free") + pages("Pages inactive") + pages("Pages speculative");
	return clampPercent(((totalBytes - reclaimablePages * pageSize) / totalBytes) * 100);
}

function vmStat(): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile("vm_stat", { timeout: 2_000, maxBuffer: 256 * 1024 }, (error, stdout) => {
			if (error) reject(error);
			else resolve(stdout);
		});
	});
}

/** Keeps one nvidia-smi process alive and caches the latest utilization per GPU. */
export class NvidiaSampler {
	private child: ChildProcess | undefined;
	private buffer = "";
	private updatedAt = 0;
	private readonly utilizationByIndex = new Map<number, number>();

	start(): void {
		if (this.child) return;
		const child = spawn("nvidia-smi", [
			"--query-gpu=index,utilization.gpu",
			"--format=csv,noheader,nounits",
			"--loop=1",
		], { stdio: ["ignore", "pipe", "ignore"] });
		this.child = child;
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => this.consume(chunk));
		const clear = () => {
			if (this.child === child) this.child = undefined;
			this.utilizationByIndex.clear();
		};
		child.once("error", clear);
		child.once("exit", clear);
		child.unref();
	}

	private consume(chunk: string): void {
		this.buffer += chunk;
		const lines = this.buffer.split(/\r?\n/);
		this.buffer = lines.pop() ?? "";
		for (const line of lines) {
			const match = /^\s*(\d+)\s*,\s*(\d+(?:\.\d+)?)\s*$/.exec(line);
			if (!match) continue;
			this.utilizationByIndex.set(Number(match[1]), clampPercent(Number(match[2])));
			this.updatedAt = Date.now();
		}
	}

	get percent(): number | undefined {
		if (this.utilizationByIndex.size === 0 || Date.now() - this.updatedAt > 3_500) return undefined;
		return Math.max(...this.utilizationByIndex.values());
	}

	stop(): void {
		this.child?.kill("SIGTERM");
		this.child = undefined;
		this.updatedAt = 0;
		this.utilizationByIndex.clear();
	}
}

export class SystemMetricCollector {
	private previousCpu = readCpuTimes();
	private readonly nvidia = new NvidiaSampler();

	start(): void {
		this.nvidia.start();
	}

	async sample(): Promise<SystemMetrics> {
		const currentCpu = readCpuTimes();
		const cpu = cpuPercent(this.previousCpu, currentCpu);
		this.previousCpu = currentCpu;

		let ram: number | undefined;
		try {
			if (process.platform === "linux") ram = linuxRamPercent(await readFile("/proc/meminfo", "utf8"));
			else if (process.platform === "darwin") ram = macRamPercent(await vmStat(), totalmem());
			else ram = clampPercent(((totalmem() - freemem()) / totalmem()) * 100);
		} catch {
			ram = undefined;
		}

		return { cpuPercent: cpu, ramPercent: ram, gpuPercent: this.nvidia.percent };
	}

	stop(): void {
		this.nvidia.stop();
	}
}
