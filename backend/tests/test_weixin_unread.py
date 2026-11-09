from app.channels.weixin.store import WeixinStore


def test_unread_survives_restart_and_duplicate_delivery(tmp_path):
    store = WeixinStore(tmp_path)
    store.receive([{'message_id': 1}, {'message_id': 1}, {'message_id': 2}], 'cursor')
    assert store.message_state()['unread_count'] == 2
    assert WeixinStore(tmp_path).message_state()['unread_count'] == 2


def test_read_watermark_does_not_clear_new_or_unprocessed_messages(tmp_path):
    store = WeixinStore(tmp_path)
    store.receive([{'message_id': 1}], 'cursor1')
    first = store.next_job()
    store.save_reply(first['id'], 'answer')
    snapshot = store.message_state()
    store.receive([{'message_id': 2}], 'cursor2')
    store.mark_read(snapshot['readable_sequence'])
    assert store.message_state()['unread_count'] == 1
    store.mark_read(99999)
    assert store.message_state()['unread_count'] == 1
    store.delivered(first['id'])
    store.save_reply(store.next_job()['id'], 'second answer')
    store.mark_read(store.message_state()['readable_sequence'])
    assert store.message_state()['unread_count'] == 0


def test_accounts_do_not_share_read_watermarks(tmp_path):
    a, b = WeixinStore(tmp_path / 'a'), WeixinStore(tmp_path / 'b')
    for store in (a, b):
        store.receive([{'message_id': 1}], 'cursor')
        store.save_reply(store.next_job()['id'], 'answer')
    a.mark_read(a.message_state()['readable_sequence'])
    assert a.message_state()['unread_count'] == 0
    assert b.message_state()['unread_count'] == 1


def test_old_binding_cannot_mark_new_binding_read(tmp_path):
    import pytest
    store = WeixinStore(tmp_path)
    store.bind({'bot_token': 'token-a', 'ilink_bot_id': 'a', 'ilink_user_id': 'owner'})
    old_binding = store.message_state()['binding_id']
    store.bind({'bot_token': 'token-b', 'ilink_bot_id': 'b', 'ilink_user_id': 'owner'})
    store.receive([{'message_id': 1}], 'cursor')
    store.save_reply(store.next_job()['id'], 'answer')
    with pytest.raises(ValueError):
        store.mark_read(99, old_binding)
    assert store.message_state()['unread_count'] == 1
