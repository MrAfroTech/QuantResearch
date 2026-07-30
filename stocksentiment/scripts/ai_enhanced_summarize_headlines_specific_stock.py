# ****************************************************************************
# Purpose:
# This script analyzes and summarizes news headlines for a specific stock symbol, 
# using sentiment analysis (positive, neutral, negative) and AI-generated summaries.
#
# Scope:
# - Input: JSON file with headlines and sentiment scores for a stock.
# - Process: 
#   1. Load the data.
#   2. Count sentiment.
#   3. Summarize the headlines with AI.
#   4. Save the results to a text file.
# - Output: A text file with sentiment breakdown and AI summary.
#
# Logic:
# 1. Check if the sentiment file exists.
# 2. Parse the data.
# 3. Summarize headlines using Hugging Face's BART model.
# 4. Save results to a file.
#
# Dependencies:
# - Python 3.8+
# - Hugging Face Transformers
# - Pre-processed JSON file with sentiment data
#
# Usage:
# 1. Run the sentiment analysis script first.
# 2. Update the stock symbol.
# 3. Run this script for the summary and sentiment breakdown.
#
# Example:
# python ai_enhanced_summarize_headlines_specific_stock.py
# ****************************************************************************



import json
from transformers import pipeline
import os

def summarize_headlines(symbol):
    # ****************************************************************************
    # Summarizes headlines and performs sentiment analysis for a specific stock ticker symbol.
    # 
    # Parameters:
    # symbol (str): The stock ticker symbol (e.g., 'AAPL', 'GOOG') to process.
    # 
    # The function loads sentiment-processed news data, filters headlines related to the given symbol,
    # performs sentiment analysis, generates a summary, and saves the results in a text file.
    # ****************************************************************************

    # Path to the sentiment-processed news file for the specific symbol
    sentiment_file = f'./data/{symbol}_news_with_sentiment.json'

    # Check if the sentiment data file exists, if not print an error message and exit
    if not os.path.exists(sentiment_file):
        print(f"Error: Sentiment file for {symbol} not found. Please run the analyze_sentiment script first.")
        return  # Exit if the file is missing

    # Load the sentiment-processed news data from the JSON file
    with open(sentiment_file, 'r') as f:
        news_data = json.load(f)

    # Initialize a dictionary to count the number of articles per sentiment category
    sentiment_count = {'positive': 0, 'neutral': 0, 'negative': 0}
    
    # Initialize a list to collect all relevant headlines for summarization
    relevant_headlines = []

    # Loop through each article in the news data to filter and process relevant headlines
    for article in news_data:
        # Get the sentiment of the article (default to 'None' if not available)
        sentiment = article.get('sentiment', None)
        
        # Check for invalid sentiment and assign default 'neutral' if sentiment is unknown
        if sentiment not in sentiment_count:
            sentiment = 'neutral'  # Default to 'neutral' if sentiment is missing or unknown
        
        # Increment the counter for the appropriate sentiment category
        sentiment_count[sentiment] += 1
        
        # Extract the headline from the article, or set to a default message if not available
        headline = article.get('headline', 'No headline available')
        
        # Add the headline to the list of relevant headlines
        relevant_headlines.append(headline)

    # Check if there are any relevant headlines collected, otherwise print a message and return
    if not relevant_headlines:
        print(f"No relevant headlines found for {symbol}.")
        return

    # Create a Hugging Face summarization pipeline using the pre-trained BART model
    summarizer = pipeline("summarization", model="facebook/bart-large-cnn")

    # Combine all relevant headlines into a single text block for summarization
    combined_text = " ".join(relevant_headlines)

    # Attempt to generate an AI-based summary of the combined headlines
    try:
        # Use the summarizer pipeline to summarize the combined text block
        summary = summarizer(
            combined_text, max_length=100, min_length=30, do_sample=False
        )[0]['summary_text']
    except Exception as e:
        # Handle any errors that occur during summarization (e.g., model issues, input size)
        print(f"Error during summarization: {e}")
        summary = "Could not generate summary due to an error."

    # Save the sentiment analysis results and the AI-generated summary to a text file
    summary_file = f'./data/{symbol}_headline_summary.txt'
    with open(summary_file, 'w') as f:
        # Write sentiment analysis results to the file
        f.write(f"Sentiment Analysis for {symbol}:\n")
        f.write(f"Positive: {sentiment_count['positive']}\n")
        f.write(f"Neutral: {sentiment_count['neutral']}\n")
        f.write(f"Negative: {sentiment_count['negative']}\n\n")
        
        # Write the AI-generated summary to the file
        f.write("AI-Generated Summary of Relevant Headlines:\n")
        f.write(summary)

    # Print a message indicating that the summary has been successfully saved
    print(f"Headline summary saved to {summary_file}.")

# This block ensures the script only runs when executed directly, not when imported as a module
if __name__ == "__main__":
    # Set the stock symbol to process (should match the symbol used in other parts of the project)
    processed_stock_symbol = "GS"  # Replace this with the appropriate symbol from your analysis
    
    # Call the function to summarize headlines for the given symbol
    summarize_headlines(processed_stock_symbol)
