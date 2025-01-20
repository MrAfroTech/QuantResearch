import yfinance as yf
import random

# Define client profiles
clients = [
    {"id": 1, "age": 22, "marital_status": "single", "salary": 72000, "dependents": 0, "net_worth": 0},
    {"id": 2, "age": 33, "marital_status": "married", "salary": 323000, "dependents": 2, "net_worth": 0},
    {"id": 3, "age": 52, "marital_status": "divorced", "salary": 650000, "dependents": 2, "net_worth": 2300000}
]

# Function to calculate risk tolerance score
def calculate_risk_tolerance(client):
    # Basic risk tolerance model based on age, dependents, and net worth
    age_factor = max(0, (100 - client["age"])) / 100
    dependents_factor = 1 / (1 + client["dependents"])
    net_worth_factor = min(1, client["net_worth"] / 1000000)  # Scale to 1M
    risk_score = (age_factor * 0.5) + (dependents_factor * 0.3) + (net_worth_factor * 0.2)
    return round(risk_score * 10, 2)  # Scale to 1-10

# Function to fetch stock data
def fetch_market_data(ticker):
    data = yf.download(ticker, period="1y", interval="1d")  # Last 1 year of daily data
    return data["Close"].mean()  # Example: Return the average close price

# Function to suggest investments based on risk score
def suggest_investments(client, market_data):
    risk_score = calculate_risk_tolerance(client)
    if risk_score > 7:
        strategy = "Aggressive: High-growth stocks, ETFs, and crypto"
        suggested_assets = random.sample(market_data["aggressive"], 3)
    elif 4 <= risk_score <= 7:
        strategy = "Moderate: Balanced portfolio of stocks, bonds, and ETFs"
        suggested_assets = random.sample(market_data["moderate"], 3)
    else:
        strategy = "Conservative: Bonds, dividend-paying stocks, and low-risk funds"
        suggested_assets = random.sample(market_data["conservative"], 3)
    
    return {"strategy": strategy, "suggested_assets": suggested_assets}

# Market data (you can expand this with real data)
market_data = {
    "aggressive": ["AAPL", "TSLA", "NVDA", "BTC-USD", "ETH-USD"],
    "moderate": ["MSFT", "GOOGL", "AMZN", "VOO", "SPY"],
    "conservative": ["JNJ", "PG", "T", "BND", "XLP"]
}

# Main function to generate investment recommendations
def generate_recommendations(clients, market_data):
    recommendations = []
    for client in clients:
        avg_prices = {asset: fetch_market_data(asset) for asset in market_data["aggressive"] + market_data["moderate"] + market_data["conservative"]}
        suggestion = suggest_investments(client, market_data)
        recommendations.append({
            "client_id": client["id"],
            "strategy": suggestion["strategy"],
            "suggested_assets": suggestion["suggested_assets"],
            "risk_tolerance_score": calculate_risk_tolerance(client),
            "avg_asset_prices": {asset: round(avg_prices[asset], 2) for asset in suggestion["suggested_assets"]}
        })
    return recommendations

# Run script
if __name__ == "__main__":
    recommendations = generate_recommendations(clients, market_data)
    for rec in recommendations:
        print(f"Client {rec['client_id']} - Strategy: {rec['strategy']}")
        print(f"Risk Tolerance Score: {rec['risk_tolerance_score']}")
        print(f"Suggested Assets (Avg Prices): {rec['avg_asset_prices']}")
        print("-" * 50)
