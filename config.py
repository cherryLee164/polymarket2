import os
from dotenv import load_dotenv
from py_clob_client.constants import POLYGON

load_dotenv()

# ==========================================
#  Core Production Config (PRODUCTION)
# ==========================================
DRY_RUN = False         #  REAL ORDERS (disable simulation)
MAX_TRADE_AMOUNT = 2.0  #  Core Edit: Single order $2.0 USDC
MAX_CONCURRENT_TRADES = 10 # Max concurrent trades
MIN_CASH_GUARD = 1.0    # Min cash guard
BALANCE_CHECK_BUFFER = 0.1  # 余额检查缓冲（$0.1）防止手续费等

# ==========================================
#  Auth Config
# ==========================================
HOST = "https://clob.polymarket.com"
CHAIN_ID = POLYGON
PRIVATE_KEY = os.getenv("PK")
RPC_URL = os.getenv("RPC_URL")  # Required for on-chain interaction
PROXY_ADDRESS = "0x3468375cbCe77260779805706a06A5D326163965"
SIGNATURE_TYPE = 1
FUNDER = PROXY_ADDRESS

# ==========================================
#  Sniper Strategy Config
# ==========================================
MIN_LIQUIDITY = 3000    
SCAN_INTERVAL = 60      
TRADE_LOG_FILE = "trade_history.log"
TOKEN_HISTORY_FILE = "token_history.log"
TOKEN_HISTORY_RETENTION_DAYS = int(os.getenv("TOKEN_HISTORY_RETENTION_DAYS", "15"))

# 日志详细模式控制
VERBOSE_ESPORTS_LOGGING = os.getenv("VERBOSE_ESPORTS_LOGGING", "false").lower() == "true"

MIN_ANNUALIZED_ROI = 0.35 
MAX_DAYS_LEFT = 1.0     #  Short-term: Settle within 24h
MIN_MINUTES_LEFT = 5    

# ==========================================
#  Football Data API
# ==========================================
FOOTBALL_DATA_TOKEN = os.getenv("FOOTBALL_DATA_TOKEN", "")

# Price range
MIN_PRICE = 0.965       
MAX_PRICE = 0.992      
MAX_SLIPPAGE = 0.01
VERBOSE_SKIP_LOG = False  # 控制是否在控制台输出重复/pending 跳过日志

BLACKLIST_KEYWORDS = [
    'Bitcoin', 'BTC', 'Ethereum', 'ETH', 'Crypto', 'Solana', 'SOL', 'XRP',
    'XRP Up or Down',
    'S&P 500', 'S&P 500 (SPX)', 'S&P', 'SPX', 'spx', 's&p 500',
    'Price of', 'price of', 'Will BTC', 'Will ETH', 'above', 'below',
    'Floor Price', 'market cap',
    # 电影票房 - 不确定性高
    'box office', 'Box Office', 'Avatar', 'movie', 'Movie', 'film', 'Film',
    'weekend box', 'opening weekend', 'theatrical', 'gross', 'Gross',
    # 娱乐/流行文化 - 不可预测
    'pop-culture', 'Grammy', 'Oscar', 'Emmy', 'Golden Globe', 'Billboard',
    'album', 'Album', 'Netflix', 'Disney', 'streaming'
]

# ==========================================
#  Brain V1 Config (Watch mode)
# ==========================================
REAL_MONEY_MODE = True         # Brain V1 live mode
BASE_BET = 5.0                 # Kelly base position
POSITION_MULTIPLIER = 1.0      # Position multiplier interface
MAX_SIGNAL_BET = 10.0          # Fed/Whale Trigger max single bet limit
AUTO_CLAIM_THRESHOLD = 20.0    # Auto claim threshold ($)
RANKING_CACHE_TTL = int(os.getenv("RANKING_CACHE_TTL", "7200"))
FOOTBALL_RANK_CACHE_TTL = int(os.getenv("FOOTBALL_RANK_CACHE_TTL", "7200"))

# ==========================================
#  Claim / Relayer Config
# ==========================================
CLAIM_DRY_RUN = os.getenv("CLAIM_DRY_RUN", "false").lower() == "true"
CLAIM_BUILD_CALLDATA = os.getenv("CLAIM_BUILD_CALLDATA", "false").lower() == "true"
CLAIM_AUTO_DEPLOY_SAFE = os.getenv("CLAIM_AUTO_DEPLOY_SAFE", "false").lower() == "true"
CLAIM_LOG_SUCCESS_ONLY = os.getenv("CLAIM_LOG_SUCCESS_ONLY", "true").lower() == "true"
CLAIM_USE_DATA_API = os.getenv("CLAIM_USE_DATA_API", "true").lower() == "true"
CLAIM_SIZE_THRESHOLD = os.getenv("CLAIM_SIZE_THRESHOLD", "0.1")
DATA_API_URL = os.getenv("DATA_API_URL", "https://data-api.polymarket.com")
CLAIM_TOKEN_IDS = os.getenv("CLAIM_TOKEN_IDS", "")
CLAIM_LOOKBACK_DAYS = int(os.getenv("CLAIM_LOOKBACK_DAYS", "60"))
CLAIM_MAX_TOKENS = int(os.getenv("CLAIM_MAX_TOKENS", "50"))
CLAIM_PARENT_COLLECTION_ID = os.getenv("CLAIM_PARENT_COLLECTION_ID", "0x" + "0" * 64)

RELAYER_URL = os.getenv("RELAYER_URL", "https://relayer-v2.polymarket.com/")
BUILDER_API_KEY = os.getenv("BUILDER_API_KEY", "")
BUILDER_SECRET = os.getenv("BUILDER_SECRET", "")
BUILDER_PASS_PHRASE = os.getenv("BUILDER_PASS_PHRASE", "")
BUILDER_PASSPHRASE = os.getenv("BUILDER_PASSPHRASE", "")

COLLATERAL_TOKEN_ADDRESS = os.getenv("COLLATERAL_TOKEN_ADDRESS", "")
CTF_ADDRESS = os.getenv("CTF_ADDRESS", "")

# ==========================================
#  Arbitrage Config (Polymarket)
# ==========================================
ARBITRAGE_DRY_RUN = True
ARBITRAGE_SCAN_INTERVAL = 60
ARBITRAGE_EVENT_LIMIT = 200
ARBITRAGE_MAX_MARKETS = 200
ARBITRAGE_MIN_LIQUIDITY = 500.0
ARBITRAGE_MAX_EVENT_USDC = 1.0
ARBITRAGE_MIN_PROFIT = 0.01
ARBITRAGE_SLIPPAGE = 0.005
ARBITRAGE_LOG_FILE = "arb_trader.log"
ARBITRAGE_TRADE_CSV = "arb_trade_log.csv"
ARBITRAGE_OPP_CSV = "arb_opportunities.csv"
ARBITRAGE_ENABLE_FILTER = False
ARBITRAGE_SPORTS_TAGS = [
    "sports",
    "soccer",
    "nba",
    "nfl",
    "mlb",
    "nhl",
    "wta",
    "atp",
    "tennis",
    "ufc",
    "mma",
    "epl",
    "champions-league",
    "world-cup",
    "golf",
    "f1",
    "formula-1",
    "motorsports",
    "boxing",
    "cricket",
    "olympics",
]
ARBITRAGE_CRYPTO_TAGS = [
    "crypto",
    "bitcoin",
    "btc",
    "ethereum",
    "eth",
    "solana",
    "sol",
    "xrp",
    "doge",
    "dogecoin",
    "defi",
    "nft",
    "onchain",
]

# ==========================================
#  Market Maker Simulation Config
# ==========================================
MM_SIM_SCAN_INTERVAL = 120
MM_SIM_PAGE_SIZE = 200
MM_SIM_MARKET_LIMIT = 500
MM_SIM_MIN_LIQUIDITY = 500.0
MM_SIM_MIN_NET_SPREAD = 0.02
MM_SIM_FEE_BUFFER = 0.005
MM_SIM_SLIPPAGE_BUFFER = 0.005
MM_SIM_MIN_PRICE = 0.05
MM_SIM_MAX_PRICE = 0.95
MM_SIM_LOG_FILE = "mm_simulator.log"
MM_SIM_OPP_CSV = "mm_simulator_opportunities.csv"
MM_SIM_SUMMARY_CSV = "mm_simulator_summary.csv"
