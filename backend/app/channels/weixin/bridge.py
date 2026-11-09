from __future__ import annotations

import json

from ag_ui.core import RunAgentInput

from ...agent.run_store import AgentRunStore
from ...chat.contracts import ChatMessageIn
from ...chat.conversations import create_conversation, get_conversation
from ...chat.execution import stream_chat_response
from ...db import connect


def record_notice(content: str, reply: str, conversation_id: int | None, notice_id: str) -> dict:
    """Persist channel-only notices so every notification has a readable target."""
    with connect() as conn:
        previous = conn.execute("""SELECT conversation_id,content FROM chat_messages
            WHERE role='assistant' AND json_extract(payload_json,'$.weixin_notice_id')=? LIMIT 1""", (notice_id,)).fetchone()
    if previous:
        return {'text': previous['content'], 'conversation_id': previous['conversation_id']}
    if not conversation_id or not get_conversation(conversation_id):
        conversation_id = create_conversation('微信会话')['id']
    payload = json.dumps({'weixin_notice_id': notice_id})
    with connect() as conn:
        conn.executemany("INSERT INTO chat_messages(role,content,payload_json,conversation_id) VALUES (?,?,?,?)", [
            ('user', content[:20000], payload, conversation_id), ('assistant', reply, payload, conversation_id)])
    return {'text': reply, 'conversation_id': conversation_id}


async def execute_message(content: str, conversation_id: int | None, run_id: str) -> dict:
    previous = AgentRunStore().get_run(run_id)
    if previous:
        conversation_id = previous.get("conversation_id") or conversation_id
    if not conversation_id or not get_conversation(conversation_id):
        conversation_id = create_conversation("微信会话")["id"]
    response = await stream_chat_response(
        ChatMessageIn(content=content, conversation_id=conversation_id),
        ag_ui_input=RunAgentInput(thread_id=str(conversation_id), run_id=run_id,
                                 state={}, messages=[], tools=[], context=[], forwarded_props={}),
    )
    async for _ in response.body_iterator:
        pass
    run = AgentRunStore().get_run(run_id)
    message_id = run.get("assistant_message_id") if run else None
    with connect() as conn:
        row = conn.execute("SELECT content FROM chat_messages WHERE id=? AND conversation_id=?", (message_id, conversation_id)).fetchone()
    text = row[0] if row and row[0] else "任务已结束，请在团团的微信会话中查看成果。"
    return {"text": text, "conversation_id": conversation_id}
