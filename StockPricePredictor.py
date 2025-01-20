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
    # Use Exponential Moving Average (EMA) instead of SMA
    data['EMA'] = data['Close'].ewm(span=window_size, adjust=False).mean()
    
    # Calculate RSI (Relative Strength Index)
    delta = data['Close'].diff()
    gain = (delta.where(delta > 0, 0)).fillna(0)
    loss = (-delta.where(delta < 0, 0)).fillna(0)
    
    avg_gain = gain.rolling(window=rsi_window).mean()
    avg_loss = loss.rolling(window=rsi_window).mean()
    
    rs = avg_gain / avg_loss
    data['RSI'] = 100 - (100 / (1 + rs))
    
    # Shift the 'Close' price to predict the next day's price
    data['Future_Close'] = data['Close'].shift(-1)
    
    # Drop NaN values (due to shift operation)
    data.dropna(inplace=True)
    
    # Feature: EMA and RSI
    # Target: Closing Price shifted by 1 day (leading indicator)
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
    

    script_directory = os.path.dirname(os.path.realpath(__file__))  # Get the script's folder
    save_path = os.path.join(script_directory, "stock_price_prediction_chart.png")  # Full path for saving
    plt.savefig(save_path)  # Save the plot
    
    print(f"Chart saved at: {save_path}")  # Confirm where the chart was saved
    
    # Close the plot
    plt.close()  # Close the plot immediately after saving it
    plt.clf()  # Clear the current figure


# Add detailed analysis of stock price performance and model
def add_analysis(data, predictions, y_test, stock_name, start_date, end_date):
    """Add basic analysis metrics to the stock prediction output"""
    
    # Calculate basic metrics
    mse = mean_squared_error(y_test, predictions)
    rmse = np.sqrt(mse)
    r2 = r2_score(y_test, predictions)
    
    # Fix FutureWarning and ensure start_price and end_price are scalars
    start_price = data['Close'].iloc[0].item()  # .item() ensures it's a scalar value
    end_price = data['Close'].iloc[-1].item()  # .item() ensures it's a scalar value
    price_change = end_price - start_price
    price_change_pct = (price_change / start_price) * 100
    
    # Calculate max and min prices explicitly as scalars
    max_price = data['Close'].max().item()  # .item() ensures it's a scalar value
    min_price = data['Close'].min().item()  # .item() ensures it's a scalar value
    
    # Print analysis
    print("\n=== Stock Price Analysis ===")
    print(f"Time Period: {start_date} to {end_date}")
    print("\nPrice Summary:")
    print(f"Starting Price: ${start_price:.2f}")  # Corrected format
    print(f"Ending Price: ${end_price:.2f}")  # Corrected format
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
    
    # Call the summary function and pass the additional parameters
    generate_financial_summary(start_price, end_price, price_change, price_change_pct, max_price, min_price, mse, rmse, r2, stock_name, start_date, end_date)

def generate_financial_summary(start_price, end_price, price_change, price_change_pct, max_price, min_price, mse, rmse, r2, stock_name, start_date, end_date):
    """Generate the condensed financial summary as a paragraph"""
    
    # Calculate the number of days in the period
    start_date_obj = pd.to_datetime(start_date)
    end_date_obj = pd.to_datetime(end_date)
    num_days = (end_date_obj - start_date_obj).days
    
    summary = (
        f"{stock_name} saw a total gain of ${price_change:.2f}, or {price_change_pct:.1f}% over the period of {num_days} days. "
        f"Starting from ${start_price:.2f}, the price reached a high of ${max_price:.2f} and a low of ${min_price:.2f}. "
        f"On average, predictions were off by ${rmse:.2f}, and the model explained {r2*100:.1f}% of the price variations. "
        "This model is best for short-term predictions based on recent trends, but may be less reliable during sudden price swings."
    )
    
    # Print the condensed financial summary
    print("\n=== Condensed Financial Summary ===")
    print(summary)
    
    return summary
# Main Function
if __name__ == "__main__":
    # Parameters
    TICKER = "AAPL"  # Replace with your desired stock symbol
    START_DATE = "2020-01-01"
    END_DATE = "2023-01-01"
    WINDOW_SIZE = 20  # EMA window size
    
    # Fetch and prepare data
    data = fetch_stock_data(TICKER, START_DATE, END_DATE)
    X, y = prepare_data(data, WINDOW_SIZE)
    X_train, X_test, y_train, y_test = split_data(X, y)
    
    # Train and evaluate the model
    model = train_model(X_train, y_train)
    predictions, mse = predict_and_evaluate(model, X_test, y_test)
    
    # Print quick analysis
    print(f"\nQuick Analysis:")
    print(f"Mean Squared Error: {mse:.2f}")
    print(f"Average prediction error: ±${np.sqrt(mse):.2f}")
    print(f"Model tends to predict the next day's price based on recent trends")
    print(f"Best for: Shorter-term predictions with recent trends")
    print(f"Less reliable for: Sudden, large price swings")
    
    # Add detailed analysis
    add_analysis(data, predictions, y_test, TICKER, START_DATE, END_DATE)
    
    # Plot results
    plot_results(data, predictions, X_test)
