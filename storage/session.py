import os
import pickle


def save_session(filename, data):

    os.makedirs(
        os.path.dirname(filename),
        exist_ok=True
    )

    with open(filename, "wb") as f:
        pickle.dump(data, f)


def load_session(filename):

    with open(filename, "rb") as f:
        return pickle.load(f)