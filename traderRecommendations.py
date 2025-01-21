import yfinance as yf
import random

# Function to simulate stock growth over 12 months
def simulate_growth(initial_investment, asset_prices, growth_factor):
    # Simulate a growth based on high risk with occasional losses
    final_amount = initial_investment
    for _ in range(12):  # Monthly investment simulation
        growth = random.uniform(1 - growth_factor, 1 + growth_factor)
        final_amount *= growth
    return final_amount

# Function to fetch stock data (average over 1 year)
def fetch_market_data(ticker):
    data = yf.download(ticker, period="1y", interval="1d")  # Last 1 year of daily data
    return data["Close"].mean()  # Return the average close price

# Define high-risk assets for aggressive growth
high_risk_assets = ["AAPL", "TSLA", "NVDA", "BTC-USD", "ETH-USD"]

# Investment target: Grow $10,000 to $35,000
target = 35000
initial_investment = 10000
growth_factor = 0.2  # 20% monthly fluctuation (high volatility for aggressive trading)

# Simulate the portfolio over 12 months
def simulate_trader_portfolio(initial_investment, high_risk_assets):
    # Fetch the average prices for the high-risk assets
    avg_prices = {asset: fetch_market_data(asset) for asset in high_risk_assets}
    
    # Calculate the total value of the portfolio after 12 months
    final_amount = simulate_growth(initial_investment, avg_prices, growth_factor)
    
    return final_amount, avg_prices

# Main function to generate the trader's strategy and results
def generate_trader_results():
    final_amount, avg_prices = simulate_trader_portfolio(initial_investment, high_risk_assets)
    
    # Check if the target is reached or exceeded
    success = final_amount >= target
    return {
        "initial_investment": initial_investment,
        "final_amount": round(final_amount, 2),
        "target_reached": success,
        "avg_asset_prices": {asset: round(price, 2) for asset, price in avg_prices.items()},
    }

# Run script
if __name__ == "__main__":
    trader_results = generate_trader_results()
    print(f"Initial Investment: ${trader_results['initial_investment']}")
    print(f"Final Portfolio Value: ${trader_results['final_amount']}")
    print(f"Target of ${target} Reached: {trader_results['target_reached']}")
    print(f"Average Asset Prices: {trader_results['avg_asset_prices']}")
