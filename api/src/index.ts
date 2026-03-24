import express from "express"

const app = express();
app.use(express.json())

app.get("/", (req, res) => { 
    res.send("yo this is me"); 
});


app.listen(8080, () => {
    console.log("api is running on http://localhost:8080")
})