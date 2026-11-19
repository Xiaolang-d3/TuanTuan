"""Conservatively identify completed legacy studio runs; ordinary chat stays in chat."""
from __future__ import annotations

import sqlite3


def backfill_image_studio(conn: sqlite3.Connection) -> None:
    prefix = '请生成一张图片：\n\n'
    # Neither the title nor image intent alone establishes provenance. The old
    # UI created a fresh named tuantuan conversation, prefixed its first turn,
    # and the run ID was also the completed image operation's primary key.
    conn.execute("""INSERT OR IGNORE INTO image_studio_tasks
        (id,conversation_id,request_hash,prompt,profile_id,model_name,status,created_at)
        SELECT o.id,c.id,'legacy:'||o.id,substr(u.content,length(:prefix)+1),
               json_extract(o.selection_json,'$.profile_id'),
               coalesce(json_extract(a.metadata_json,'$.model_name'),''),'done',o.created_at
        FROM chat_image_operations o
        JOIN agent_execution_runs r ON r.run_id=o.id AND r.conversation_id=o.conversation_id
        JOIN conversations c ON c.id=o.conversation_id AND c.title='图片创作' AND c.kernel='tuantuan'
        JOIN chat_messages u ON u.id=r.user_message_id AND u.conversation_id=c.id AND u.role='user'
        JOIN chat_image_assets a ON a.operation_id=o.id AND a.conversation_id=c.id AND a.message_id=r.assistant_message_id
        WHERE o.status='done' AND r.status='completed' AND r.user_content=u.content
          AND substr(u.content,1,length(:prefix))=:prefix
          AND NOT EXISTS (SELECT 1 FROM chat_messages prev WHERE prev.conversation_id=c.id AND prev.id<u.id)
        """, {'prefix': prefix})

    # Published edits already store their direct parent asset on the assistant
    # message. Follow only descendants of recognized roots (including edits of
    # edits) and require the actual saved asset to belong to that message.
    conn.execute("""WITH RECURSIVE edges AS (
          SELECT DISTINCT o.id,o.conversation_id,o.selection_json,o.result_json,o.created_at,
                 json_extract(m.payload_json,'$.agent.source_asset_id') parent_id,
                 p.operation_id parent_operation, json_extract(a.metadata_json,'$.model_name') model
          FROM chat_image_assets a JOIN chat_image_operations o ON o.id=a.operation_id AND o.status='done'
          JOIN chat_messages m ON m.id=a.message_id AND m.role='assistant' AND m.conversation_id=o.conversation_id
          JOIN chat_image_assets p ON p.id=json_extract(m.payload_json,'$.agent.source_asset_id')
                                 AND p.conversation_id=o.conversation_id
          WHERE json_extract(o.selection_json,'$.edit_digest') IS NOT NULL
        ), tree(id) AS (
          SELECT id FROM image_studio_tasks UNION SELECT e.id FROM edges e JOIN tree t ON t.id=e.parent_operation
        ) INSERT OR IGNORE INTO image_studio_tasks
          (id,conversation_id,request_hash,prompt,profile_id,model_name,status,source_asset_id,created_at)
          SELECT e.id,e.conversation_id,json_extract(e.selection_json,'$.edit_digest'),
                 coalesce(json_extract(e.result_json,'$.image_generation_prompt'),'图片编辑'),
                 json_extract(e.selection_json,'$.profile_id'),coalesce(e.model,''),'done',e.parent_id,e.created_at
          FROM edges e JOIN tree t ON t.id=e.id""")
