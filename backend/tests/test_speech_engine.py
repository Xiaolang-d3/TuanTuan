from types import SimpleNamespace
from unittest.mock import Mock

import numpy as np
import pytest

from app.speech_engine import DictationStream, SpeechEngine, SAMPLE_RATE, DEFAULT_HOTWORDS


def engine(events):
    online = Mock(return_value=[{"preds": ("边说边出自", [])}])
    return SimpleNamespace(vad=Mock(side_effect=events), new_online=Mock(return_value=online),
                           transcribe=Mock(return_value="边说边出字。"))


def test_vad_boundaries_drive_streaming_revisions_and_sentence_finalization():
    model = engine([[[[0, -1]]], [], [[[-1, 1000]]]])
    stream = DictationStream(model)
    audio = np.arange(6400, dtype=np.float32) / 6400
    assert stream.push(audio) == []
    assert stream.push(audio) == [{"segmentId": 0, "revision": 1, "text": "边说边出自", "final": False}]
    final = stream.push(audio)[0]
    assert final == {"segmentId": 0, "revision": 2, "text": "边说边出字。", "final": True}
    np.testing.assert_array_equal(model.transcribe.call_args.args[0], np.tile(audio, 3)[:16000])
    assert model.transcribe.call_args.args[1] == DEFAULT_HOTWORDS
    assert stream.start is None
    assert model.new_online.call_count == 2


def test_short_speech_gets_a_final_result_even_without_a_streaming_preview():
    model = engine([[[[0, 200]]]])
    stream = DictationStream(model)
    assert stream.push(np.ones(6400, dtype=np.float32))[0]["final"] is True
    assert len(model.transcribe.call_args.args[0]) == 3200


def test_silence_keeps_bounded_pre_roll_and_never_calls_asr():
    model = engine([[]] * 100)
    stream = DictationStream(model)
    for _ in range(100):
        assert stream.push(np.zeros(6400, dtype=np.float32)) == []
    assert len(stream.audio) == SAMPLE_RATE
    model.new_online.return_value.assert_not_called()
    model.transcribe.assert_not_called()


def test_late_vad_start_replays_the_buffered_onset_and_two_sentences_do_not_overlap():
    model = engine([[], [[[200, -1]]], [[[-1, 900], [1000, -1]]], [[[-1, 1500]]]])
    stream = DictationStream(model, ("测试词",))
    audio = np.arange(25600, dtype=np.float32)
    updates = []
    for i in range(0, len(audio), 6400):
        updates.extend(stream.push(audio[i:i+6400]))
    calls = model.transcribe.call_args_list
    np.testing.assert_array_equal(calls[0].args[0], audio[3200:14400])
    np.testing.assert_array_equal(calls[1].args[0], audio[16000:24000])
    assert calls[0].args[1] == ("测试词",)
    assert [u["segmentId"] for u in updates if u["final"]] == [0, 1]


@pytest.mark.parametrize("failure", [None, RuntimeError("offline failed")])
def test_sentence_failure_or_empty_output_keeps_the_preview(failure):
    model = engine([[[[0, -1]]], [], [[[-1, 1000]]]])
    model.transcribe.side_effect = failure
    model.transcribe.return_value = ""
    stream = DictationStream(model)
    for _ in range(2):
        stream.push(np.ones(6400, dtype=np.float32))
    assert stream.push(np.ones(6400, dtype=np.float32))[0]["text"].startswith("边说边出自")


def test_long_speech_is_bounded_and_continues_without_a_new_vad_start():
    model = engine([[[[0, -1]]]] + [[]] * 69 + [[[[ -1, 28000]]]])
    model.transcribe.side_effect = ["第一句。", "第一句。第二句。"]
    stream = DictationStream(model)
    finals = []
    for _ in range(71):
        finals.extend(u for u in stream.push(np.ones(6400, dtype=np.float32)) if u["final"])
        assert len(stream.audio) <= 25 * SAMPLE_RATE
    assert [u["segmentId"] for u in finals] == [0, 1]
    assert len(model.transcribe.call_args_list[0].args[0]) == 25 * SAMPLE_RATE
    assert len(model.transcribe.call_args_list[1].args[0]) == 4 * SAMPLE_RATE
    assert finals[1]["text"] == "第二句。"


def test_contextual_hotwords_reach_the_model_and_punctuation_failure_preserves_words():
    model = SpeechEngine.__new__(SpeechEngine)
    model.offline = Mock(return_value=[{"preds": ("你好团团", [])}])
    model.punctuation = Mock(return_value=["你好，团团。"])
    audio = np.zeros(16000, dtype=np.float32)
    assert model.transcribe(audio, ("团团", "工作区")) == "你好，团团。"
    assert model.offline.call_args.kwargs == {"hotwords": "团团 工作区"}
    model.punctuation.side_effect = RuntimeError("punc failed")
    assert model.transcribe(audio) == "你好团团"


def test_session_caches_are_independent_when_audio_is_interleaved():
    model = engine([[[[0, -1]]], [[[0, -1]]], [], []])
    first, second = DictationStream(model), DictationStream(model)
    for stream in [first, second, first, second]:
        stream.push(np.ones(6400, dtype=np.float32))
    vad_caches = [call.kwargs["param_dict"] for call in model.vad.call_args_list]
    assert vad_caches[0] is vad_caches[2]
    assert vad_caches[1] is vad_caches[3]
    assert vad_caches[0] is not vad_caches[1]
    assert first.online_cache is not second.online_cache


def test_english_words_keep_spaces_between_streaming_chunks():
    model = engine([[[[0, -1]]], [], []])
    model.new_online.return_value.side_effect = [{"preds": ("hello", [])}], [{"preds": ("world", [])}]
    stream = DictationStream(model)
    updates = []
    for _ in range(3):
        updates.extend(stream.push(np.ones(6400, dtype=np.float32)))
    assert updates[-1]["text"] == "hello world"


def test_forced_vad_cut_reuses_context_and_preserves_a_real_repeated_word():
    model = engine([[[[0, -1]]], [[[-1, 800], [800, -1]]], [[[-1, 1200]]]])
    model.transcribe.side_effect = ["请检查。", "请检查检查结果。"]
    stream = DictationStream(model)
    updates = []
    for _ in range(3):
        updates.extend(stream.push(np.ones(6400, dtype=np.float32)))
    assert [u["text"] for u in updates if u["final"]] == ["请检查。", "检查结果。"]
    assert len(model.transcribe.call_args_list[1].args[0]) == 19200


def test_a_new_utterance_after_a_pause_keeps_its_repeated_start():
    model = engine([[[[0, 400]]], [], [[[1000, -1]]], [[[-1, 1500]]]])
    model.transcribe.side_effect = ["检查。", "检查完成。"]
    stream = DictationStream(model)
    updates = []
    for _ in range(4):
        updates.extend(stream.push(np.ones(6400, dtype=np.float32)))
    assert [u["text"] for u in updates if u["final"]] == ["检查。", "检查完成。"]


def test_continuation_hides_context_only_previews():
    model = engine([[], [], []])
    model.new_online.return_value.side_effect = [[{"preds": ("检", [])}], [{"preds": ("查完成", [])}]]
    stream = DictationStream(model)
    stream.start = 0
    stream.context = "检查。"
    stream.committed_until = 16000
    assert stream.push(np.ones(6400, dtype=np.float32)) == []
    assert stream.push(np.ones(6400, dtype=np.float32)) == []
    assert stream.push(np.ones(6400, dtype=np.float32))[0]["text"] == "完成"
