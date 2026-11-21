from forex_replay.__main__ import main


def test_hello_prints_greeting(capsys):
    main(["hello"])
    assert "ForexReplay is working" in capsys.readouterr().out
