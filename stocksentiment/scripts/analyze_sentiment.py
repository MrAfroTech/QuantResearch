from textblob import TextBlob
import json

def analyze_sentiment(news_article):
    # Perform sentiment analysis on the news article's headline
    analysis = TextBlob(news_article['headline'])
    polarity = analysis.sentiment.polarity

    # Classify sentiment based on polarity
    if polarity > 0:
        return 'positive'
    elif polarity == 0:
        return 'neutral'
    else:
        return 'negative'

def process_news_data(symbol):
    # Load the news data from the previously fetched file
    with open(f'./data/{symbol}_news.json', 'r') as f:
        news_data = json.load(f)

    # Initialize counters
    sentiment_count = {'positive': 0, 'neutral': 0, 'negative': 0}
    summaries = []

    # Analyze sentiment for each article and update the data
    for article in news_data:
        sentiment = analyze_sentiment(article)
        article['sentiment'] = sentiment
        sentiment_count[sentiment] += 1
        summaries.append(article['headline'])

    # Create a summary of all headlines
    summary_text = "\n".join(summaries)

    # Save the updated news data with sentiment analysis and summary
    with open(f'./data/{symbol}_news_with_sentiment.json', 'w') as f:
        json.dump(news_data, f, indent=4)

    # Save the sentiment count and summary to a separate text file
    with open(f'./data/{symbol}_sentiment_summary.txt', 'w') as f:
        f.write(f"Sentiment Analysis for {symbol}:\n")
        f.write(f"Positive: {sentiment_count['positive']}\n")
        f.write(f"Neutral: {sentiment_count['neutral']}\n")
        f.write(f"Negative: {sentiment_count['negative']}\n\n")
        f.write("Summary of all news headlines:\n")
        f.write(summary_text)

    print(f"Sentiment analysis and summary for {symbol} completed successfully.")

if __name__ == "__main__":
    symbol = 'AAPL'  # Example: Use AAPL (Apple) for testing; change as needed
    process_news_data(symbol)
