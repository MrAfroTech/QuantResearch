import os
import json
from transformers import pipeline

def load_market_sentiment_data(file_path):
    """Load market sentiment analysis results from a JSON file."""
    with open(file_path, 'r') as file:
        return json.load(file)

def filter_market_articles(articles):
    """
    Filter articles to include only market-relevant content.
    
    Args:
        articles (list): List of article dictionaries
    
    Returns:
        list: Filtered list of market-related articles
    """
    market_keywords = [
        'market', 'stock', 'finance', 'economic', 'trading', 
        'investment', 'business', 'financial', 'economy', 
        'sector', 'portfolio', 'earnings', 'trade', 'commodity',
        'wall street', 'nasdaq', 'dow jones', 's&p', 'federal reserve'
    ]
    
    filtered_articles = []
    for article in articles:
        # Check title and description for market keywords
        text = f"{article.get('title', '')} {article.get('description', '')}".lower()
        if any(keyword in text for keyword in market_keywords):
            filtered_articles.append(article)
    
    return filtered_articles

def summarize_market_sentiment(data):
    """
    Use AI to generate a focused market sentiment summary.
    
    Args:
        data (dict): Market sentiment report data
    
    Returns:
        str: AI-generated market insights summary
    """
    # Combine and filter bullish and bearish articles
    all_articles = (
        data.get('top_bullish_articles', []) + 
        data.get('top_bearish_articles', [])
    )
    
    # Filter for market-relevant articles
    market_articles = filter_market_articles(all_articles)
    
    # Check if we have market-related articles
    if not market_articles:
        return "No significant market-related articles found for analysis."
    
    # Prepare text for summarization
    market_text = " ".join([
        f"{article.get('title', '')} {article.get('description', '')}" 
        for article in market_articles[:5]  # Limit to top 5 articles
    ])
    
    # Truncate text to prevent processing issues
    market_text = market_text[:3000]
    
    # Use AI summarization
    summarizer = pipeline("summarization", model="facebook/bart-large-cnn")
    summary = summarizer(market_text, max_length=110, min_length=50, do_sample=False)
    
    return summary[0]['summary_text']

def main():
    # Find the most recent market sentiment report
    reports_dir = "market_sentiment_reports"
    reports = [os.path.join(reports_dir, f) for f in os.listdir(reports_dir)]
    latest_report = max(reports, key=os.path.getmtime)
    
    # Load and summarize market sentiment
    market_data = load_market_sentiment_data(latest_report)
    
    # Generate AI summary
    market_summary = summarize_market_sentiment(market_data)
    
    # Print summary
    print("\n--- Market Sentiment AI Summary ---")
    print(f"Timeframe: {market_data.get('timeframe', 'Unknown')}")
    print(f"Market Trend: {market_data.get('market_trend', 'Undetermined')}")
    print("\nAI Market Insights:")
    print(market_summary)

if __name__ == "__main__":
    main()