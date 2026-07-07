import httpx

url = "https://datafeed.dukascopy.com/datafeed/EURUSD/2026/00/01/BID_candles_min_5.bi5"

try:
    response = httpx.get(url, timeout=30)

    print("Status Code:", response.status_code)
    print("Downloaded:", len(response.content), "bytes")

except Exception as e:
    print(e)