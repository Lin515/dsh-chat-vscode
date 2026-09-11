import type { SettingsFieldView, SettingsSectionView } from "../shared/chat";

/**
 * 设置 schema → 表单字段。
 *
 * 刻意与 vscode 无关（放在 dsh/ 而不是 controller 里），这样冒烟测试能直接
 * 验证转换结果，不必启动扩展宿主。
 */

/**
 * Schemastery 的 `toJSON()` 结构：一张以 uid 为键的扁平表，
 * 根节点由顶层 `uid` 指向。节点类型有 object(dict) / string / number /
 * boolean / array(inner) / union(list of const) / const(value)。
 */
interface SchemaNode {
  uid?: number;
  type?: string;
  meta?: {
    default?: unknown;
    required?: boolean;
    min?: number;
    max?: number;
    step?: number;
    role?: string;
    description?: string;
  };
  dict?: Record<string, number>;
  inner?: number;
  list?: number[];
  value?: unknown;
  refs?: Record<string, SchemaNode>;
}

/** 密钥字段路径拼成服务端 credentials 的 ref 形式。 */
export function secretKey(path: string[]): string {
  return [...path].join(".");
}

/**
 * 找出密钥字段对应的凭据引用名。
 *
 * 约定是同一层里有一个 `role: credential-ref` 的兄弟字段给出引用
 * （通常是 `<密钥名>Env`，例如 `apiKey` ↔ `apiKeyEnv`）。引用空间是
 * POSIX 环境变量名，不是设置路径，所以只能从这里取。
 */
function matchCredentialRef(secretField: string, refs: Record<string, string>): string | undefined {
  const preferred = `${secretField}Env`;
  if (refs[preferred]) return refs[preferred];
  const values = Object.values(refs).filter(Boolean);
  return values.length === 1 ? values[0] : undefined;
}

/** 判断某个路径在对象里是否存在（用于标记「被用户覆盖」）。 */
function hasPath(source: unknown, path: string[]): boolean {
  let cursor: unknown = source;
  for (const key of path) {
    if (!cursor || typeof cursor !== "object" || !(key in (cursor as Record<string, unknown>))) return false;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return true;
}

export interface SettingsNamespaceInput {
  ns: string;
  schema?: unknown;
  value?: unknown;
  user?: unknown;
  applies?: string;
  secrets?: { path: string[]; set: boolean }[];
  revision?: number;
}

/**
 * 把一个命名空间视图展开成可渲染的表单字段。
 *
 * 只处理能安全表达为输入框的类型；对象数组（例如模型清单）交给 JSON 编辑器，
 * 免得用户在一个「表单」里被静默改坏结构。
 */
export function buildSettingsSection(ns: SettingsNamespaceInput): SettingsSectionView {
  const root = ns.schema as SchemaNode | undefined;
  const refs = root?.refs ?? {};
  const value = (ns.value ?? {}) as Record<string, unknown>;
  const user = ns.user as Record<string, unknown> | undefined;
  const fields: SettingsFieldView[] = [];
  const jsonFields: SettingsSectionView["jsonFields"] = [];
  /** 本层声明的凭据引用：字段名 → 引用名。 */
  const credentialRefs: Record<string, string> = {};

  // 顶层是信封 {uid, refs}：真正的根节点要从 refs 里按 uid 取，
  // 信封自身没有 type/dict，直接当根节点会解析出 0 个字段。
  const resolve = (uid: number | undefined): SchemaNode | undefined =>
    uid === undefined ? undefined : refs[String(uid)];

  const walk = (
    node: SchemaNode | undefined,
    path: string[],
    current: unknown,
    inUser: boolean,
  ): void => {
    if (!node?.dict) {
      // 走到没有结构的节点：只有带路径的才值得落到 JSON 编辑器
      if (path.length) jsonFields.push({ path, label: path.join("."), value: current });
      return;
    }
    // 先扫一遍本层，收集凭据引用：字段顺序不保证 `apiKeyEnv` 排在 `apiKey`
    // 之后，单趟循环会拿不到引用名。
    for (const [key, childUid] of Object.entries(node.dict)) {
      const child = resolve(childUid);
      if (child?.meta?.role !== "credential-ref") continue;
      const currentValue =
        current && typeof current === "object" ? (current as Record<string, unknown>)[key] : undefined;
      credentialRefs[key] =
        typeof currentValue === "string" && currentValue ? currentValue : String(child.meta?.default ?? "");
    }

    for (const [key, childUid] of Object.entries(node.dict)) {
      const child = resolve(childUid);
      const childPath = [...path, key];
      const childValue =
        current && typeof current === "object" ? (current as Record<string, unknown>)[key] : undefined;
      const childInUser = Boolean(inUser && user && hasPath(user, childPath));

      if (!child) {
        jsonFields.push({ path: childPath, label: childPath.join("."), value: childValue });
        continue;
      }

      // 嵌套一层对象继续下钻（设置里的分组），更深的交给 JSON
      if (child.type === "object" && child.dict && path.length < 1) {
        walk(child, childPath, childValue, childInUser);
        continue;
      }

      if (child.type === "union" && child.list) {
        const options = child.list
          .map((uid) => resolve(uid))
          .filter((item): item is SchemaNode => Boolean(item))
          .map((item) => ({ value: String(item.value), label: String(item.value) }));
        fields.push({
          path: childPath,
          label: childPath.join("."),
          type: "enum",
          value: childValue ?? child.meta?.default,
          defaultValue: child.meta?.default,
          options,
          overridden: childInUser,
        });
        continue;
      }

      if (child.type === "boolean") {
        fields.push({
          path: childPath,
          label: childPath.join("."),
          type: "boolean",
          value: Boolean(childValue ?? child.meta?.default),
          defaultValue: child.meta?.default,
          overridden: childInUser,
        });
        continue;
      }

      if (child.type === "number") {
        fields.push({
          path: childPath,
          label: childPath.join("."),
          type: "number",
          value: typeof childValue === "number" ? childValue : child.meta?.default,
          defaultValue: child.meta?.default,
          min: child.meta?.min,
          max: child.meta?.max,
          step: child.meta?.step,
          overridden: childInUser,
        });
        continue;
      }

      if (child.type === "string") {
        const isSecret = child.meta?.role === "secret";
        const setFlag = ns.secrets?.some((secret) => secretKey(secret.path) === secretKey(childPath));
        fields.push({
          path: childPath,
          label: childPath.join("."),
          type: "string",
          // 密钥永不回显：服务端只回 set 状态
          value: isSecret ? "" : String(childValue ?? child.meta?.default ?? ""),
          defaultValue: child.meta?.default,
          secret: isSecret,
          secretRef: isSecret ? matchCredentialRef(key, credentialRefs) : undefined,
          secretSet: setFlag || undefined,
          overridden: childInUser,
        });
        continue;
      }

      jsonFields.push({ path: childPath, label: childPath.join("."), value: childValue });
    }
  };

  walk(resolve(root?.uid) ?? root, [], value, true);

  return {
    ns: ns.ns,
    applies: ns.applies === "restart" ? "restart" : "live",
    revision: ns.revision ?? 0,
    fields,
    jsonFields,
    writable: true,
  };
}
