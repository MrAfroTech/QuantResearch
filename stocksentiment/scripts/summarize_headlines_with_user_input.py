import json
import os

def summarize_headlines(symbol):
    """
    Summarize the headlines from the sentiment-processed news file for the given stock symbol.

    Args:
        symbol (str): Stock ticker symbol.
    """
    # Define the path to the sentiment-processed news file
    sentiment_file = f'./data/{symbol}_news_with_sentiment.json'

    # Check if the file exists
    if not os.path.exists(sentiment_file):
        print(f"Error: Sentiment file for {symbol} not found. Please run the analyze_sentiment script first.")
        return

    # Load the sentiment-processed news data
    with open(sentiment_file, 'r') as f:
        news_data = json.load(f)

    # Initialize counters for sentiment
    sentiment_count = {'positive': 0, 'neutral': 0, 'negative': 0}
    summaries = []

    # Process each article
    for article in news_data:
        sentiment = article.get('sentiment', 'unknown')
        headline = article.get('headline', 'No headline available')
        sentiment_count[sentiment] += 1
        summaries.append(headline)

    # Create a summary of all headlines
    summary_text = "\n".join(summaries)

    # Print the sentiment analysis results
    print(f"\nSentiment Analysis for {symbol}:")
    print(f"Positive: {sentiment_count['positive']}")
    print(f"Neutral: {sentiment_count['neutral']}")
    print(f"Negative: {sentiment_count['negative']}")
    print("\nSummary of all headlines:")
    print(summary_text)

    # Save the summary to a text file
    summary_file = f'./data/{symbol}_headline_summary.txt'
    with open(summary_file, 'w') as f:
        f.write(f"Sentiment Analysis for {symbol}:\n")
        f.write(f"Positive: {sentiment_count['positive']}\n")
        f.write(f"Neutral: {sentiment_count['neutral']}\n")
        f.write(f"Negative: {sentiment_count['negative']}\n\n")
        f.write("Summary of all news headlines:\n")
        f.write(summary_text)

    print(f"\nHeadline summary saved to {summary_file}.")

if __name__ == "__main__":
    # List of available stock symbols
    stock_symbols = [
        "AAPL", "GOOGL", "AMZN", "MSFT", "TSLA", 
        "META", "NFLX", "NVDA", "SPY", "AMD", 
        "BA", "DIS", "GS", "BRK.A", "V"
    ]

    print("Please choose a stock symbol to summarize from the list below:")
    for i, symbol in enumerate(stock_symbols, start=1):
        print(f"{i}. {symbol}")

    choice = int(input("\nEnter the number corresponding to your choice: "))
    if 1 <= choice <= len(stock_symbols):
        selected_symbol = stock_symbols[choice - 1]
        summarize_headlines(selected_symbol)
    else:
        print("Invalid choice. Please run the script again and select a valid number.")
