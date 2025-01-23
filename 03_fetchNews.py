import requests
from bs4 import BeautifulSoup

url = "https://finance.yahoo.com/quote/AAPL/news"
response = requests.get(url)
soup = BeautifulSoup(response.content, "html.parser")

# Extract news headlines
headlines = soup.find_all('h3')
for headline in headlines:
    print(headline.text)
