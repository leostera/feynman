// The balance and what was paid out add up to what the account opened with.
spec MoneyAddsUp observes eBooks {
  start state Watching {
    on eBooks do (b: (balance: int, paidOut: int)) {
      assert b.balance + b.paidOut == 100, "the balance and what was paid out do not add up";
    }
  }
}
