// 辨識「本機 RAG」的 MCP 工具（RagMcp 的 12 個工具），對應 C# 的 Core/Services/RagTools.cs。
// 工具名稱是 mcp__<伺服器名稱>__rag_xxx；不限定伺服器名稱（使用者註冊時可以取任何名字），只看最後一段是不是這 12 個動作之一。
// 掃描器（摘要）與流程圖（泡泡）共用，避免兩邊各自判斷。

const Actions = new Set(['rag_search', 'rag_sources', 'rag_status', 'rag_tables', 'rag_chunks', 'rag_chunk', 'rag_index', 'rag_remove', 'rag_prune', 'rag_todo', 'rag_annotate', 'rag_ingest_note']);

/** "mcp__local-rag__rag_search" → "rag_search"；不是本機 RAG 的工具回傳 null。 */
export function ragActionOf(tool: string): string | null {
  const parts = tool.split('__');
  return parts.length >= 3 && parts[0] === 'mcp' && Actions.has(parts[parts.length - 1]) ? parts[parts.length - 1] : null;
}

/** 會改變索引的動作（索引、刪除、清理）；它們預設只試跑，是否真的寫入看 dry_run。 */
export function isRagWrite(action: string | null): boolean {
  return action === 'rag_index' || action === 'rag_remove' || action === 'rag_prune' || action === 'rag_ingest_note';
}
