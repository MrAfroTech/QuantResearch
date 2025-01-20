# =============================================================================
# Stock Price Prediction Script with Linear Regression and Technical Indicators
# =============================================================================
# This script fetches historical stock data, processes it using Exponential Moving Average (EMA)
# and Relative Strength Index (RSI) indicators, then applies linear regression to predict 
# the next day's stock price. The model performance is evaluated using metrics like 
# Mean Squared Error (MSE), Root Mean Squared Error (RMSE), and R² score. It also visualizes 
# the predicted and actual stock prices on a plot and generates a condensed financial summary 
# of the stock performance over the specified period.
#
# The script includes the following steps:
# 1. Fetching historical stock data using Yahoo Finance API.
# 2. Data preparation by calculating EMA and RSI, and shifting closing prices to predict the next day's price.
# 3. Training a linear regression model with the prepared data.
# 4. Evaluating the model's predictions and performance using MSE, RMSE, and R² score.
# 5. Plotting the actual and predicted prices over time.
# 6. Generating a financial summary including stock price change, model performance, and interpretation.
#
# The script can be customized by adjusting the stock ticker, date range, and other model parameters.
# The results include a plot of stock prices and an output summary detailing the model's accuracy and 
# the stock's performance over the selected period.
# =============================================================================

import yfinance as yf
import pandas as pd
import numpy as np
import os
import sklearn
from sklearn.model_selection import train_test_split
from sklearn.linear_model import LinearRegression
from sklearn.metrics import mean_squared_error, r2_score
import matplotlib.pyplot as plt

# Step 1: Fetch Historical Stock Data
def fetch_stock_data(ticker, start_date, end_date):
    data = yf.download(ticker, start=start_date, end=end_date)
    data['Date'] = data.index
    return data[['Date', 'Close']]

# Step 2: Prepare Data for Linear Regression with EMA and RSI
def prepare_data(data, window_size, rsi_window=14):
    data['EMA'] = data['Close'].ewm(span=window_size, adjust=False).mean()
    
    delta = data['Close'].diff()
    gain = (delta.where(delta > 0, 0)).fillna(0)
    loss = (-delta.where(delta < 0, 0)).fillna(0)
    
    avg_gain = gain.rolling(window=rsi_window).mean()
    avg_loss = loss.rolling(window=rsi_window).mean()
    
    rs = avg_gain / avg_loss
    data['RSI'] = 100 - (100 / (1 + rs))
    
    data['Future_Close'] = data['Close'].shift(-1)
    data.dropna(inplace=True)
    
    X = data[['EMA', 'RSI']]
    y = data['Future_Close']
    
    return X, y

# Step 3: Train-Test Split
def split_data(X, y):
    return train_test_split(X, y, test_size=0.2, random_state=42)

# Step 4: Train Linear Regression Model
def train_model(X_train, y_train):
    model = LinearRegression()
    model.fit(X_train, y_train)
    return model

# Step 5: Predict and Evaluate
def predict_and_evaluate(model, X_test, y_test):
    predictions = model.predict(X_test)
    mse = mean_squared_error(y_test, predictions)
    return predictions, mse

# Step 6: Visualize Results
def plot_results(data, predictions, X_test):
    plt.figure(figsize=(10, 6))
    plt.plot(data['Date'], data['Close'], label="Actual Prices", color="blue")
    plt.scatter(X_test.index, predictions, label="Predicted Prices", color="red", alpha=0.7)
    plt.xlabel("Date")
    plt.ylabel("Stock Price")
    plt.title("Stock Price Prediction with Linear Regression")
    plt.legend()
    
    script_directory = os.path.dirname(os.path.realpath(__file__))
    save_path = os.path.join(script_directory, "stock_price_prediction_chart.png")
    plt.savefig(save_path)
    
    print(f"Chart saved at: {save_path}")
    
    plt.close()
    plt.clf()

def add_analysis(data, predictions, y_test, stock_name, start_date, end_date):
    mse = mean_squared_error(y_test, predictions)
    rmse = np.sqrt(mse)
    r2 = r2_score(y_test, predictions)
    
    start_price = data['Close'].iloc[0].item()
    end_price = data['Close'].iloc[-1].item()
    price_change = end_price - start_price
    price_change_pct = (price_change / start_price) * 100
    
    max_price = data['Close'].max().item()
    min_price = data['Close'].min().item()
    
    print("\n=== Stock Price Analysis ===")
    print(f"Time Period: {start_date} to {end_date}")
    print("\nPrice Summary:")
    print(f"Starting Price: ${start_price:.2f}")
    print(f"Ending Price: ${end_price:.2f}")
    print(f"Total Change: ${price_change:.2f} ({price_change_pct:.1f}%)")
    print(f"Highest Price: ${max_price:.2f}")
    print(f"Lowest Price: ${min_price:.2f}")
    
    print("\nModel Performance:")
    print(f"Mean Squared Error: {mse:.2f}")
    print(f"Root Mean Squared Error: ${rmse:.2f}")
    print(f"R² Score: {r2:.3f}")
    
    print("\nSimple Interpretation:")
    print(f"• On average, predictions were off by ${rmse:.2f}")
    print(f"• The model explains {r2*100:.1f}% of price variations")
    if r2 < 0.5:
        print("• Model accuracy is poor, consider using more features")
    elif r2 < 0.7:
        print("• Model accuracy is moderate")
    else:
        print("• Model accuracy is good")
    
    generate_financial_summary(start_price, end_price, price_change, price_change_pct, max_price, min_price, mse, rmse, r2, stock_name, start_date, end_date)

def generate_financial_summary(start_price, end_price, price_change, price_change_pct, max_price, min_price, mse, rmse, r2, stock_name, start_date, end_date):
    start_date_obj = pd.to_datetime(start_date)
    end_date_obj = pd.to_datetime(end_date)
    num_days = (end_date_obj - start_date_obj).days
    
    summary = (
        f"{stock_name} saw a total gain of ${price_change:.2f}, or {price_change_pct:.1f}% over the period of {num_days} days. "
        f"Starting from ${start_price:.2f}, the price reached a high of ${max_price:.2f} and a low of ${min_price:.2f}. "
        f"On average, predictions were off by ${rmse:.2f}, and the model explained {r2*100:.1f}% of the price variations. "
        "This model is best for short-term predictions based on recent trends, but may be less reliable during sudden price swings."
    )
    
    print("\n=== Condensed Financial Summary ===")
    print(summary)
    
    return summary

def predict_future_prices_with_trend(model, data, X_latest, days=60, trend_type="linear"):
    """Predict the next 'days' future stock prices with trend adjustment and volatility."""
    future_predictions = []
    X_current = X_latest.copy()

    # Start by predicting the next day's price
    next_prediction = model.predict([X_current.iloc[-1]])[0]
    future_predictions.append(next_prediction)

    # Calculate the trend from the original 'data' which includes the 'Close' prices
    price_changes = data['Close'].diff().dropna()  # Calculate daily price changes
    average_change = price_changes.mean()  # Use average change as a trend reference
    volatility = price_changes.std()  # Calculate standard deviation for volatility

    # Predict future prices considering the trend and volatility
    for _ in range(days - 1):
        # Add randomness based on volatility (simulating price fluctuations)
        random_noise = np.random.normal(0, volatility)  # Simulate random price fluctuations
        next_prediction = future_predictions[-1] + average_change + random_noise
        future_predictions.append(next_prediction)

    return future_predictions


# Main Function
if __name__ == "__main__":
    TICKER = "AAPL"  # Replace with your desired stock symbol
    START_DATE = "2020-01-01"
    END_DATE = (pd.to_datetime("today") - pd.tseries.offsets.BDay(1)).strftime('%Y-%m-%d')  # Current date minus 1 business day
    WINDOW_SIZE = 20  # EMA window size
    
    data = fetch_stock_data(TICKER, START_DATE, END_DATE)
    X, y = prepare_data(data, WINDOW_SIZE)
    X_train, X_test, y_train, y_test = split_data(X, y)
    
    model = train_model(X_train, y_train)
    predictions, mse = predict_and_evaluate(model, X_test, y_test)
    
    print(f"\nQuick Analysis:")
    print(f"Mean Squared Error: {mse:.2f}")
    print(f"Average prediction error: ±${np.sqrt(mse):.2f}")
    print(f"Model tends to predict the next day's price based on recent trends")
    print(f"Best for: Shorter-term predictions with recent trends")
    print(f"Less reliable for: Sudden, large price swings")
    
    add_analysis(data, predictions, y_test, TICKER, START_DATE, END_DATE)
    
    plot_results(data, predictions, X_test)
    
    # Predict future prices for the next 60 days
    future_prices_with_trend = predict_future_prices_with_trend(model, data, X_test, days=60)

    for i, price in enumerate(future_prices_with_trend, 1):
        print(f"Day {i}: ${float(price):.2f}")