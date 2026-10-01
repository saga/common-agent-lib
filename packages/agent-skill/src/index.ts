import fs from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import * as z from 'zod';

/** Skill 的执行语义；复杂程度不是分类标准。 */
export const SkillKindSchema = z.enum(['capability', 'workflow']);
export type SkillKind = z.infer<typeof SkillKindSchema>;

/** name/description 保持 Agent Skills 约定；kind 是本项目对执行语义的最小扩展。 */
export const SkillMetadataSchema = z.object({ kind: SkillKindSchema }).strict();
export type SkillMetadata = z.infer<typeof SkillMetadataSchema>;

export const SkillManifestSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().trim().min(1),
  metadata: SkillMetadataSchema.optional(),
}).passthrough();
export type SkillManifest = z.infer<typeof SkillManifestSchema>;

export interface ParseSkillOptions {
  /** 企业内部建议开启；关闭时可读取没有 kind 的标准 Skill。 */
  requireKind?: boolean;
}

export interface SkillManifestWithSource extends SkillManifest {
  sourcePath?: string;
}

/** 从 Markdown 中取出 frontmatter；正文由调用方继续处理。 */
function splitFrontmatter(markdown: string): { frontmatter: string; body: string } {
  const match = /^---[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n---[ \\t]*(?:\\r?\\n|$)/.exec(markdown);
  if (!match) throw new Error('SKILL.md 缺少有效的 frontmatter。');
  return { frontmatter: match[1] ?? '', body: markdown.slice(match[0].length) };
}

/**
 * 解析并校验一个 SKILL.md。
 * 使用真正的 YAML parser，避免用正则猜 description / metadata。
 */
export function parseSkillMarkdown(markdown: string, options: ParseSkillOptions = {}): SkillManifestWithSource {
  const { frontmatter } = splitFrontmatter(markdown);
  const raw = parseYaml(frontmatter);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('SKILL.md 的 frontmatter 必须是对象。');
  }
  const manifest = SkillManifestSchema.parse(raw);
  if (options.requireKind && !manifest.metadata?.kind) {
    throw new Error('SKILL.md 必须声明 metadata.kind: capability 或 workflow。');
  }
  return manifest;
}

export async function loadSkillManifest(skillDirectory: string, options: ParseSkillOptions = {}): Promise<SkillManifestWithSource> {
  const skillPath = path.join(skillDirectory, 'SKILL.md');
  const markdown = await fs.readFile(skillPath, 'utf8');
  const manifest = parseSkillMarkdown(markdown, options);
  return { ...manifest, sourcePath: skillPath };
}

/** 只负责 discovery，不替应用决定哪些 Skill 应该启用。 */
export async function discoverSkills(skillsDirectory: string, options: ParseSkillOptions = {}): Promise<SkillManifestWithSource[]> {
  const entries = await fs.readdir(skillsDirectory, { withFileTypes: true });
  const result: SkillManifestWithSource[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      result.push(await loadSkillManifest(path.join(skillsDirectory, entry.name), options));
    } catch (error) {
      throw new Error('Skill ' + entry.name + ' 无法读取：' + (error instanceof Error ? error.message : String(error)));
    }
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

/** 只有 workflow Skill 才能进入 Workflow runtime。 */
export function assertWorkflowSkill(manifest: SkillManifest): void {
  if (manifest.metadata?.kind !== 'workflow') {
    throw new Error('Skill ' + manifest.name + ' 的 kind 不是 workflow，不能作为 Workflow 加载。');
  }
}

export function hasWorkflowDefinition(markdown: string): boolean {
  return /^##\\s+@flow\\s+/m.test(markdown);
}

/** capability 不应偷偷定义 @flow；workflow 必须定义 @flow。 */
export function validateSkill(markdown: string, options: ParseSkillOptions = { requireKind: true }): string[] {
  const manifest = parseSkillMarkdown(markdown, options);
  const hasFlow = hasWorkflowDefinition(markdown);
  if (manifest.metadata?.kind === 'capability' && hasFlow) return ['capability Skill 不应该定义 @flow。'];
  if (manifest.metadata?.kind === 'workflow' && !hasFlow) return ['workflow Skill 必须定义 @flow。'];
  return [];
}