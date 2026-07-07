import pandas as pd

def load_data(file_path):
    df = pd.read_csv(file_path)

    # Convert time column to datetime
    df["time"] = pd.to_datetime(df["time"])

    return df